const os = require('os');

function getNetworkUrls(host, port, publicBaseUrl) {
    const urls = [];

    if (publicBaseUrl) {
        urls.push(publicBaseUrl);
    }

    if (host === '0.0.0.0' || host === '::') {
        urls.push(`http://localhost:${port}`);

        const interfaces = os.networkInterfaces();
        for (const entries of Object.values(interfaces)) {
            for (const entry of entries || []) {
                if (
                    entry &&
                    entry.family === 'IPv4' &&
                    !entry.internal &&
                    entry.address
                ) {
                    urls.push(`http://${entry.address}:${port}`);
                }
            }
        }
    } else {
        urls.push(`http://${host}:${port}`);
    }

    return [...new Set(urls)];
}

module.exports = {
    getNetworkUrls,
};
