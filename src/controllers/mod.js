'use strict';

/**
 * Pterodactyl - Daemon
 * Copyright (c) 2015 - 2018 Dane Everitt <dane@daneeveritt.com>.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const rfr = require('rfr');
const Dockerode = require('dockerode');
const Async = require('async');
const Request = require('request');
const Fs = require('fs-extra');
const Path = require('path');
const Util = require('util');
const _ = require('lodash');
const isStream = require('isstream');
const createOutputStream = require('create-output-stream');

const ConfigHelper = rfr('src/helpers/config.js');
const ImageHelper = rfr('src/helpers/image.js');

const Config = new ConfigHelper();
const DockerController = new Dockerode({
    socketPath: Config.get('docker.socket', '/var/run/docker.sock'),
});

class Mod {
    constructor(data, server) {
        // console.log(server)
        data = JSON.parse(data);

        server.log.warn = server.log.info;
        this.server = server;
        this.log = {};
        this.modInstall = data.mod;
        this.modVariables = data.variables;
        this.processLogger = undefined;

        console.log(data);

    }

    pull(next) {
        this.server.log.debug('Contacting panel to determine scripts to run for mod processes.');
        return next(null, this.modInstall);
    }

    install(next) {
        this.server.log.info('Blocking server boot until option installation process is completed.');
        this.server.blockBooting = true;

        Async.auto({
            details: callback => {
                this.server.log.debug('Contacting remote server to pull scripts to be used.');
                this.pull(callback);
            },
            write_file: ['details', (results, callback) => {

                console.log()
                
                if (_.isNil(_.get(this.modInstall, 'install_script', null))) {
                    // No script defined, skip the rest.
                    const error = new Error('No installation script was defined for this egg, skipping rest of process.');
                    error.code = 'E_NOSCRIPT';
                    return callback(error);
                }
                // Remove \r 
                this.modInstall.install_script = this.modInstall.install_script.replace(/\r\n/g, '\n');

                this.server.log.debug('Writing temporary file to be handed into the Docker container.');
                Fs.outputFile(Path.join('/tmp/pterodactyl/', this.server.json.uuid, `/install-mod${this.modInstall.id}.sh`), this.modInstall.install_script, {
                    mode: 0o644,
                    encoding: 'utf8',
                }, callback);
            }],
            image: ['write_file', (results, callback) => {
                const PullImage = _.get(this.modInstall, 'install_script_container', 'alpine:3.4');
                this.server.log.debug(`Pulling ${PullImage} image if it is not already on the system.`);
                ImageHelper.pull(PullImage, callback);
            }],
            close_stream: ['write_file', (results, callback) => {
                if (isStream.isWritable(this.processLogger)) {
                    this.processLogger.close();
                    this.processLogger = undefined;
                    return callback();
                }
                return callback();
            }],
            setup_stream: ['close_stream', (results, callback) => {
                const LoggingLocation = Path.join(this.server.path(), `install${this.modInstall.id}.log`);
                this.server.log.info({ file: LoggingLocation }, 'Writing output of installation process to file.');
                this.processLogger = createOutputStream(LoggingLocation, {
                    mode: 0o644,
                    defaultEncoding: 'utf8',
                });
                return callback();
            }],
            /* suspend: ['image', (results, callback) => {
                // this.server.log.info('Temporarily suspending server to avoid mishaps...');
                // this.server.suspend(callback);
            }],*/
            run: ['setup_stream', 'image', (results, callback) => {
                this.server.log.debug('Running privileged docker container to perform the installation process.');

                const environment = [];
                environment.push(`SERVER_MEMORY=${this.server.json.build.memory}`);
                environment.push(`SERVER_IP=${this.server.json.build.default.ip}`);
                environment.push(`SERVER_PORT=${this.server.json.build.default.port}`);


                console.log(1)
                _.forEach(this.modVariables, variable => {
                    console.log(`PUSH : ${variable.key}=${variable.value}`)
                    environment.push(`${variable.key}=${variable.value}`);
                });
                console.log(0)

                DockerController.run(_.get(this.modInstall, 'install_script_container', 'alpine:3.4'), [_.get(this.modInstall, 'install_script_entry', 'ash'), `/mnt/install/install-mod${this.modInstall.id}.sh`], (Config.get('logger.level', 'info') === 'debug') ? process.stdout : this.processLogger, {
                    Tty: true,
                    AttachStdin: true,
                    AttachStdout: true,
                    AttachStderr: true,
                    Env: environment,
                    Mounts: [
                        {
                            Source: this.server.path(),
                            Destination: '/mnt/server',
                            RW: true,
                        },
                        {
                            Source: Path.join('/tmp/pterodactyl/', this.server.json.uuid),
                            Destination: '/mnt/install',
                            RW: true,
                        },
                    ],
                    HostConfig: {
                        Privileged: true, // _.get(results.details, 'scripts.privileged', false), DANGER DISABLED"!!!!!
                        Binds: [
                            Util.format('%s:/mnt/server', this.server.path()),
                            Util.format('%s:/mnt/install', Path.join('/tmp/pterodactyl/', this.server.json.uuid)),
                        ],
                    },
                }, (err, data, container) => {
                    if (_.isObject(container) && _.isFunction(_.get(container, 'remove', null))) {
                        container.remove();
                    }

                    if (data.StatusCode !== 0) {
                        return callback(new Error(`Install script failed with code ${data.StatusCode}`));
                    }

                    if (err) {
                        return callback(err);
                    }

                    this.server.log.info('Completed installation process for mod.');
                    this.server.blockBooting = false;
                    callback(err, data);
                });
            }],
            close_logger: ['run', (results, callback) => {
                if (isStream.isWritable(this.processLogger)) {
                    this.processLogger.close();
                    this.processLogger = undefined;
                }
                return callback();
            }],
            remove_install_script: ['run', (results, callback) => {
                Fs.unlink(Path.join('/tmp/pterodactyl/', this.server.json.uuid, `/install-mod${this.modInstall.id}.sh`), callback);
            }],
            chown: ['run', (results, callback) => {
                this.server.log.debug('Properly chowning all server files and folders after installation.');
                this.server.fs.chown('/', callback);
            }],
        }, err => {
            // this.server.unsuspend(() => { _.noop(); });

            // No script, no need to kill everything.
            if (err && err.code === 'E_NOSCRIPT') {
                this.server.log.info(err.message);
                return next();
            }

            return next(err);
        });
    }
}

module.exports = Mod;
