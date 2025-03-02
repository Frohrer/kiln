// Globals are things the user shouldn't change in config, but is good to not use inline constants for
const is_docker = require('is-docker');
const fs = require('fs');
const platform = `${is_docker() ? 'docker' : 'baremetal'}-${fs
    .read_file_sync('/etc/os-release')
    .toString()
    .split('\n')
    .find(x => x.startsWith('ID'))
    .replace('ID=', '')}`;
const SIGNALS = {
    SIGTERM: 'SIGTERM',
    SIGKILL: 'SIGKILL',
    SIGINT: 'SIGINT'
};

const pkg_installed_file = '.ppman-installed';

module.exports = {
    data_directories: {
        packages: 'packages',
    },
    version: require('../package.json').version,
    platform,
    pkg_installed_file,
    clean_directories: ['/dev/shm', '/run/lock', '/tmp', '/var/tmp'],
    SIGNALS,
};
