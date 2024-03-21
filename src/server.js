const express = require('express');
const http = require('http');
const cors = require('cors');
const morgan = require('morgan');
const cluster = require('cluster');
const { Server } = require('socket.io');

require('dotenv').config();

const router = require('./routes/routes');
const dbUtility = require('./utilities/db');
const constant = require('./constants/config');
const { onConnection } = require('./services/webSocket');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
    },
});


const connectedClients = new Map();

io.on(constant.EVENT.CONNECTION, (socket) => {
    onConnection(socket, io, connectedClients);
});

const required_options = [
    'SERVER_BIND_IP',
    'SERVER_BIND_PORT',
    'DATABASE_SELECT',
    'HEALTHY_SYNC_TIME_DIFF',
    'API_PATH_PREFIX',
    'CPU_CORES',
    'MAX_RECORD_COUNT',
    'MAX_WS_TRANSACTIONS_COUNT',
    'MAX_WS_EVENT_LOGS_COUNT',
    'CONNECTION_POOL',
];

required_options.forEach((item, i) => {
    if (process.env[item] === undefined) {
        console.error(`Environment option ${item} is not defined`);
        process.exit(1);
    }
});

app.use(
    cors({
        origin: '*',
    })
);

app.use(
    morgan(
        ':method :url :status :res[content-length] - :response-time ms :remote-addr'
    )
);
app.use(express.json());

app.use(`/${process.env.API_PATH_PREFIX}`, router);

app.get(`/${process.env.API_PATH_PREFIX}`, (req, res) => {
    res.send('Memento API');
});

dbUtility.CreateConnectionPool();

var port = process.env.SERVER_BIND_PORT || 12345;
var bind_ip = process.env.SERVER_BIND_IP || '0.0.0.0';

createClusteredServer(bind_ip, port, process.env.CPU_CORES);

//create clustered server and bind with specified ip address and port number
function createClusteredServer(ip, port, clusterSize) {
    if (clusterSize > 1) {
        if (cluster.isMaster) {
            console.log(`Master ${process.pid} is running`);

            // Fork workers.
            for (let i = 0; i < clusterSize; i++) {
                cluster.fork();
            }

            cluster.on('exit', (worker, code, signal) => {
                console.log(`worker ${worker.process.pid} died`);
                if (signal == 'SIGKILL') {
                    gracefulExit();
                    process.exit(0);
                } else {
                    cluster.fork();
                }
                console.log('Starting a new worker ');
            });
        } else {
            server.listen(port, ip, () => {
                console.log(`listening on port no ${port}`);
            });
            console.log(`Worker ${process.pid} started`);
        }
    } else {
        server.listen(port, ip, () => {
            console.log(`listening on port no ${port}`);
        });
    }
}

var gracefulExit = function () {
    console.log('Close DB connection');
    dbUtility.CloseConnection();
    process.exit(0);
};

// If the Node process ends, close the DB connection
process.on('SIGINT', gracefulExit).on('SIGTERM', gracefulExit);

process.on('uncaughtException', function (error) {
    console.log('uncaughtException ' + error);
});

process.on('unhandledRejection', function (reason, p) {
    console.log('unhandledRejection ' + reason);
});

module.exports = app;
