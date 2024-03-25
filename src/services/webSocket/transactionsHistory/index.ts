import { Socket } from 'socket.io';
import {
    State,
    SocketId,
    TransactionType,
    Args,
    SocketState,
    ForkTransactionEntity,
    TraceTransactionEntity,
} from './types';

import db from '../../../utilities/db'; // @TODO: add typescript to DB configuration
import { EVENT, EVENT_ERRORS } from '../../../constants/config';
import {
    isNumber,
    isNotEmptyArray,
    isNotEmptyArrayOfAccounts,
} from '../../../utilities/helpers';

const TRACE_TRANSACTIONS_BLOCKS_THRESHOLD =
    Number(process.env.WS_TRACE_TRANSACTIONS_BLOCKS_THRESHOLD) ?? 100;
const TRACE_TRANSACTIONS_LIMIT =
    Number(process.env.WS_TRACE_TRANSACTIONS_LIMIT) ?? 100;
const FORK_TRANSACTIONS_LIMIT =
    Number(process.env.WS_FORK_TRANSACTIONS_LIMIT) ?? 100;

const EMIT_INTERVAL_TIME = 1000; // Time in milliseconds to emit transactions_history event
const FORK_TRANSACTIONS_SCAN_INTERVAL_TIME = 500; // Time in milliseconds to scan the fork transactions

const state: State = {
    sockets: {},
    forks: { data: [], lastForkId: 0 }, // forks.data represents the fork transactions, which this service will scan and emit to the clients when requested
    forksIntervalId: null,
};

function manageForkTransactionsScanning(connectionsCount: number) {
    if (connectionsCount > 0 && !state.forksIntervalId) {
        // start scanning the fork transactions if there are active socket connections
        state.forksIntervalId = setInterval(async () => {
            try {
                await scanForkTransactions();
            } catch (error) {
                console.error('error scanning fork transactions:', error);
            }
        }, FORK_TRANSACTIONS_SCAN_INTERVAL_TIME);
    }
    if (!connectionsCount && state.forksIntervalId) {
        // stop scanning the fork transactions if there are no active socket connections
        clearInterval(state.forksIntervalId);
        state.forksIntervalId = null;
    }
}

// scan the fork transactions and save them to the state
async function scanForkTransactions() {
    let fromId: number;

    if (!state.forks.lastForkId) {
        const lastIrreversibleBlock = await db.GetIrreversibleBlockNumber();
        const from = await getForkTransactionByBlockNum(lastIrreversibleBlock);

        fromId = from[0][(db as any).is_mysql ? 'MAX(id)' : 'max'];
    } else {
        fromId = state.forks.lastForkId;
    }

    const forks = await getForkTransactions({
        fromId,
        toId: Number(fromId) + FORK_TRANSACTIONS_LIMIT,
    });

    if (isNotEmptyArray(forks)) {
        state.forks = {
            data: forks,
            lastForkId: forks[0]?.id,
        };
    }
}

function getSocketStateActions(socketId: SocketId) {
    return {
        initializeSocketState: () => {
            state.sockets[socketId] = {
                intervalId: null,
                lastTransactionBlockNum: 0,
                transactionType: 'fork',
            };
        },
        getSocketState: () => state.sockets[socketId],
        setSocketState: (newState: Partial<SocketState>) => {
            state.sockets[socketId] = {
                ...state.sockets[socketId],
                ...newState,
            };
        },
        clearSocketState: () => {
            const interval = state.sockets[socketId]?.intervalId;
            if (interval) {
                clearInterval(interval);
            }

            const socketState = state.sockets[socketId];
            if (socketState) {
                delete state.sockets[socketId];
            }
        },
    };
}

async function onTransactionsHistory(socket: Socket, args: Args) {
    const { valid, message } = validateArgs(args);

    if (!valid) {
        socket.emit(EVENT.ERROR, message ?? EVENT_ERRORS.INVALID_ARGS);

        // abort the connection after 1 second if the arguments are invalid
        setTimeout(() => socket.disconnect(), 1000);
        return;
    }
    const { initializeSocketState, setSocketState, getSocketState } =
        getSocketStateActions(socket.id);

    // initialize the state for the socket connection (only once per connection)
    if (!getSocketState()) {
        initializeSocketState();
    }

    // send the transactions history to the client every EMIT_INTERVAL_TIME milliseconds
    setSocketState({
        intervalId: setInterval(async () => {
            try {
                await emitTransactionsHistory(socket, args);
            } catch (error) {
                console.error('error emitting transactions history:', error);
            }
        }, EMIT_INTERVAL_TIME),
    });
}

async function emitTransactionsHistory(
    socket: Socket,
    { accounts, start_block, irreversible = false }: Args
) {
    const { setSocketState, getSocketState } = getSocketStateActions(socket.id);
    const { lastTransactionBlockNum, transactionType } = getSocketState();

    const headBlock = await db.GetLastSyncedBlockNumber();
    const lastIrreversibleBlock = await db.GetIrreversibleBlockNumber();

    const startBlock = Math.max(
        start_block ?? headBlock,
        lastTransactionBlockNum
    );

    const shouldSwitchToTrace = shouldSwitchToTraceType({
        start_block,
        startBlock,
        lastIrreversibleBlock,
        irreversible,
        transactionType,
    });

    const shouldSwitchToFork = shouldSwitchToForkType({
        lastTransactionBlockNum,
        lastIrreversibleBlock,
        start_block,
        irreversible,
        transactionType,
    });

    // If a client is too slow in consuming the stream,
    // the server should switch from head block back to scanning EVENT_LOG specifically for this client.
    // If the scanning delays behind the last irreversible block,
    // the server should switch to scanning RECEIPTS and TRANSACTIONS.
    // @TODO: Implement the logic above

    if (shouldSwitchToTrace) {
        setSocketState({
            transactionType: 'trace',
        });
        return;
    }

    if (shouldSwitchToFork) {
        setSocketState({
            transactionType: 'fork',
        });
        return;
    }

    emitTransactionsBasedOnType({
        transactionType,
        socket,
        accounts,
        startBlock,
        lastIrreversibleBlock,
        irreversible,
    });
}

function shouldSwitchToTraceType({
    start_block,
    startBlock,
    lastIrreversibleBlock,
    irreversible,
    transactionType,
}: {
    start_block?: Args['start_block'];
    startBlock: number;
    lastIrreversibleBlock: number;
    irreversible: Args['irreversible'];
    transactionType: TransactionType;
}) {
    return (
        ((start_block && startBlock < Number(lastIrreversibleBlock)) ||
            irreversible) &&
        transactionType !== 'trace'
    );
}

function shouldSwitchToForkType({
    lastTransactionBlockNum,
    lastIrreversibleBlock,
    start_block,
    irreversible,
    transactionType,
}: {
    lastTransactionBlockNum: number;
    lastIrreversibleBlock: number;
    start_block?: Args['start_block'];
    irreversible: Args['irreversible'];
    transactionType: TransactionType;
}) {
    return (
        (lastTransactionBlockNum >= lastIrreversibleBlock || !start_block) &&
        !irreversible &&
        transactionType !== 'fork'
    );
}

async function emitTransactionsBasedOnType({
    transactionType,
    socket,
    accounts,
    startBlock,
    lastIrreversibleBlock,
    irreversible,
}: {
    transactionType: TransactionType;
    socket: Socket;
    accounts: Args['accounts'];
    startBlock: number;
    lastIrreversibleBlock: number;
    irreversible: Args['irreversible'];
}) {
    switch (transactionType) {
        case 'trace': {
            const count = await getTraceTransactionsCount({
                accounts,
                fromBlock: startBlock,
                toBlock: startBlock + TRACE_TRANSACTIONS_BLOCKS_THRESHOLD,
            });

            const threshold = calculateTraceTxsBlockThreshold(
                count,
                startBlock
            );

            const toBlock = irreversible
                ? Math.min(threshold, lastIrreversibleBlock)
                : threshold;

            const shouldExecute =
                startBlock < toBlock && lastIrreversibleBlock !== startBlock;

            if (shouldExecute) {
                emitTraceTransactions(socket, {
                    accounts,
                    fromBlock: startBlock,
                    toBlock,
                });
            }
            break;
        }
        case 'fork': {
            emitForkTransactions(socket, { accounts });
            break;
        }
    }
}

async function emitTraceTransactions(
    socket: Socket,
    {
        accounts,
        fromBlock,
        toBlock,
    }: {
        accounts: Args['accounts'];
        fromBlock: number;
        toBlock: number;
    }
) {
    const { setSocketState } = getSocketStateActions(socket.id);

    const transactionsHistory = await getTraceTransactions({
        accounts,
        fromBlock,
        toBlock,
    });

    if (isNotEmptyArray(transactionsHistory)) {
        const lastTransactionBlockNum = transactionsHistory[0].block_num;
        setSocketState({
            lastTransactionBlockNum: Number(lastTransactionBlockNum),
        });
    }

    socket.emit(
        EVENT.TRANSACTIONS_HISTORY,
        formatTransactions(transactionsHistory, 'trace', accounts)
    );
}

async function emitForkTransactions(
    socket: Socket,
    { accounts }: { accounts: Args['accounts'] }
) {
    socket.emit(
        EVENT.TRANSACTIONS_HISTORY,
        formatTransactions(state.forks.data, 'fork', accounts)
    );
}

function validateArgs(args: Args) {
    const { accounts, start_block, irreversible } = args;

    switch (true) {
        case typeof args !== 'object':
            return {
                valid: false,
                message: EVENT_ERRORS.INVALID_ARGS,
            };
        case !isNotEmptyArrayOfAccounts(accounts):
            return {
                valid: false,
                message: EVENT_ERRORS.INVALID_ACCOUNTS,
            };
        case start_block && !isNumber(start_block):
            return {
                valid: false,
                message: EVENT_ERRORS.INVALID_START_BLOCK,
            };
        case irreversible && typeof irreversible !== 'boolean':
            return {
                valid: false,
                message: EVENT_ERRORS.INVALID_IRREVERSIBLE,
            };
        case irreversible && !start_block:
            return {
                valid: false,
                message: EVENT_ERRORS.START_BLOCK_BEHIND_LAST_IRREVERSIBLE,
            };
        default:
            return {
                valid: true,
            };
    }
}

function formatTransactions(
    transactions: (ForkTransactionEntity | TraceTransactionEntity)[],
    type: TransactionType,
    accounts: string[]
) {
    const parsedTraces = transactions.map(({ trace, ...tx }) => ({
        ...tx,
        type,
        data: JSON.parse(trace.toString('utf8')),
    }));

    const isFork = type === 'fork';

    return isFork
        ? parsedTraces.filter((tx) =>
              (tx.data.trace.action_traces as { receiver: string }[]).some(
                  ({ receiver }) => accounts.includes(receiver)
              )
          )
        : parsedTraces;
}

async function getTraceTransactions({
    accounts,
    fromBlock,
    toBlock,
}: {
    accounts: Args['accounts'];
    fromBlock: number;
    toBlock: number;
}): Promise<TraceTransactionEntity[]> {
    return db.ExecuteQueryAsync(`
        SELECT ${(db as any).is_mysql ? '' : 'R.'}block_num, trace
        FROM (
            SELECT DISTINCT seq${(db as any).is_mysql ? '' : ', block_num'}
            FROM RECEIPTS
            WHERE receiver IN (${accounts.map((account) => `'${account}'`).join()})
            AND block_num >= '${fromBlock}'
            AND block_num <= '${toBlock}'
            ORDER BY block_num DESC
        ) AS R
        INNER JOIN TRANSACTIONS ON R.seq = TRANSACTIONS.seq
    `);
}
async function getForkTransactionByBlockNum(blockNum: number) {
    return db.ExecuteQueryAsync(`
        SELECT MAX(id) 
        FROM EVENT_LOG 
        where block_num = '${blockNum}' 
    `);
}

async function getForkTransactions({
    fromId,
    toId,
}: {
    fromId: number;
    toId: number;
}): Promise<ForkTransactionEntity[]> {
    return db.ExecuteQueryAsync(
        `
        SELECT id, block_num, data as trace
        FROM EVENT_LOG
        WHERE id > '${fromId}'
        AND id <= '${toId}'
        ORDER BY id DESC
    `
    );
}

async function getTraceTransactionsCount({
    accounts,
    fromBlock,
    toBlock,
}: {
    accounts: Args['accounts'];
    fromBlock: number;
    toBlock: number;
}) {
    const count = await db.ExecuteQueryAsync(
        `
        SELECT COUNT(DISTINCT seq)
        FROM RECEIPTS
        WHERE receiver IN (${accounts.map((account) => `'${account}'`).join()})
        AND block_num >= '${fromBlock}'
        AND block_num < '${toBlock}'
    `
    );
    return (db as any).is_mysql
        ? count[0]['COUNT(DISTINCT seq)']
        : count[0].count;
}

function calculateTraceTxsBlockThreshold(count: number, startBlock: number) {
    // The size of the chunk is determined as follows:
    // we get the number of traces within the next 100 blocks(the number is configurable),
    // and if it's more than 100 traces (configurable), the block range is reduced proportionally.
    if (count > TRACE_TRANSACTIONS_LIMIT) {
        const ratio = count / TRACE_TRANSACTIONS_BLOCKS_THRESHOLD;
        return Math.floor(
            startBlock + (1 / ratio) * TRACE_TRANSACTIONS_BLOCKS_THRESHOLD
        );
    }

    return startBlock + TRACE_TRANSACTIONS_BLOCKS_THRESHOLD;
}

export {
    onTransactionsHistory,
    getSocketStateActions,
    manageForkTransactionsScanning,
};
