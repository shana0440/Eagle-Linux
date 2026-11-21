const {JsonServerProc} = require('./sever_proc');
const http = require('http');

const DEFAULT_PORT = 8080;

// Eagle's browser extension calls from its background page: a browser
// User-Agent with no Origin, or an extension Origin. Web pages send their own
// Origin, Eagle's windows add Eagle/ to the User-Agent and scripts have theirs.
function isBrowserExtension(request) {
    const userAgent = request.headers['user-agent'] ?? '';
    const origin = request.headers.origin;
    return userAgent.startsWith('Mozilla/') && !userAgent.includes('Eagle/')
        && (!origin || /^[a-z-]+-extension:\/\//.test(origin));
}

/**
 * Json HTTP Server
 */
class JsonRestServer extends JsonServerProc {

    /**
     * Constructor of Json HTTP server
     * .
     * The configration properties are bellow.
     * 
     * | Name | Type | Description |
     * | --- | --- | --- |
     * | port | `number `| The port number that the server listning. |
     * | ignore404 | `boolean` | The server not return 404(NOT FOUND) status on this module. |
     * 
     * if you want to inherit othor server (like you implemented),
     *  set 'true for `ignore404`, 
     * and pass into the 2nd argument `server`.
     * 
     * 
     * @param {object} conf  configration  of this server
     * @param {HTTPServer} server HTTP  server.
     */
    constructor(conf, server) {
        super(conf);
        if(server == undefined) {
            this._server = http.createServer();
        }
        else {
            this._server = server;
        }

        this._server.on('request', (request, response)=>{
            this.proc(request, response);
        });
    }
    /**
     * Add api
     * @param {string} api entry point (pathname) of api.
     * @param {string} method http method. GET, DELETE, POST, PUT
     * @param {function} callback implementation of server function.
     */
    addAPI(api, method, callback, options) {
        return super.addAPI(api, method, callback, options);
    }

    // Handlers get a second argument that says who called.
    _callAPI(fn, request) {
        const caller = { browserExtension: isBrowserExtension(request) };
        return super._callAPI((args) => fn(args, caller), request);
    }

    /**
     * Start the server listning.
     * @param {function} callback the call back function when the server is ready.
     */
    start(callback) {
        const port = (this._conf.port == undefined) ? DEFAULT_PORT : this._conf.port;

        this._server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.log(`[JSON_SERVER] Port ${port} occupied, listening on fallback port ${port + 2}`);
                try { this._server.listen(port + 2); } catch(e){}
            }
        });

        try {
            this._server.listen(port);
        } catch(e) {}
        if(callback != void 0) {
            callback();
        }
    }


    /**
     * Stop ther server.
     * @param {function} callback callback function when the server is stopped.
     */
    stop(callback) {
        this._server.close(callback);
    }

}
module.exports = {
    DEFAUL_PORT: DEFAULT_PORT,
    JsonRestServer: JsonRestServer
};