#!/usr/bin/env node
require('nocamel');
const Logger = require('logplease');
const express = require('express');
const expressWs = require('express-ws');
const globals = require('./globals');
const config = require('./config');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const body_parser = require('body-parser');
const runtime = require('./runtime');
const {test} = require('./test')

const logger = Logger.create('index');
const app = express();
expressWs(app);


app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

(async () => {
    logger.info('Setting loglevel to', config.log_level);
    Logger.setLogLevel(config.log_level);
    logger.debug('Ensuring data directories exist');

    Object.values(globals.data_directories).for_each(dir => {
        let data_path = path.join(config.data_directory, dir);

        logger.debug(`Ensuring ${data_path} exists`);

        if (!fss.exists_sync(data_path)) {
            logger.info(`${data_path} does not exist.. Creating..`);

            try {
                fss.mkdir_sync(data_path, { recursive: true });
            } catch (e) {
                logger.error(`Failed to create ${data_path}: `, e.message);
            }
        }
    });

    logger.info('Loading packages');
    
    // Load Firecracker VM images instead of isolate packages
    const firecrackerService = require('./firecracker-service');
    const imagesDir = firecrackerService.imagesDir;
    
    if (!fss.exists_sync(imagesDir)) {
        logger.info(`Creating Firecracker images directory at ${imagesDir}`);
        fss.mkdir_sync(imagesDir, { recursive: true });
    }

    // Register any existing Firecracker VM images
    try {
        const images = fss.readdir_sync(imagesDir);
        images
            .filter(file => file.endsWith('.ext4'))
            .forEach(image => {
                const imagePath = path.join(imagesDir, image);
                logger.debug(`Loading VM image: ${imagePath}`);
                runtime.load_package(imagePath);
            });
    } catch (error) {
        logger.error('Error loading VM images:', error);
    }

    logger.info('Starting API Server');
    logger.debug('Constructing Express App');
    logger.debug('Registering middleware');

    app.use(body_parser.urlencoded({ extended: true }));
    app.use(body_parser.json());

    // Error handling middleware
    app.use((err, req, res, next) => {
        logger.error('Error occurred:', err);
        return res.status(400).send({
            message: err.message,
            stack: err.stack,
        });
    });
    

    logger.debug('Registering Routes');

    const api_v2 = require('./api/v2');
    app.use('/api/v2', api_v2);

    const { version } = require('../package.json');

    // Render the web interface at the root route '/'
    app.get('/', (req, res, next) => {
        res.render('index', { version: version });
    });
    app.get('/health', (req, res, next) => {
        res.status(200).json({'status':'healthy'})
    });

    // // 404 handler
    // app.use((req, res, next) => {
    //     return res.status(404).send({ message: 'Not Found' });
    // });

    logger.debug('Calling app.listen');
    const [address, port] = config.bind_address.split(':');

    const server = app.listen(port, address, () => {
        logger.info('API server started on', config.bind_address);
    });

    process.on('SIGTERM', () => {
        logger.info('Received SIGTERM signal, shutting down server...');
        server.close(() => {
            logger.info('Server closed');
        });
    });
})();

