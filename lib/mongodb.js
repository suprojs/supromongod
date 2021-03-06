/*
 * Start/Restart/Stop mongodb service (daemon)
 * Setup robust MongoDB connection using native driver
 * NOTE default port = 27727 (option in `config.modules.supromongod.port`)
 */
(function MongoDB(require, module){

/* ,-< Stop mongod Processes >-
 * |
 * |In a clean shutdown a mongod completes all pending operations,
 * |flushes all data to data files, and closes all data files.
 * |Other shutdowns are unclean and can compromise the validity the data files.
 * |
 * `-<http://docs.mongodb.org/manual/tutorial/manage-mongodb-processes/>
 *
 * Our Clean shutdown stratery is to run
 * > db.admin.command({ shutdown: 1 })
 *
 * on shutdown event `mongod` will finish all pending requests (as per docs)
 * and then close event of `db` will free everything in the driver
 * no need of internal accounting and/or checking of
 * `serverStatus.metrics.cursor.open.total` on db.close()
 */

var mongodb = require('mongodb')
// module data
var mongod// spawned daemon
var db, api, cfg
var colls_cache = { }// collections which may have additional dynamic fields

/* == API for Mongodb access ==
 *
 * launch/connect MongoDB binary with provided config then try to connect to it
 * @param {hash} app_api glue hash connecting all used internal parts
 * @param {hash} config db setup and connection settings
 * Example:
  require('./mongodb').launch/connect(api,{
    //TODO (see db_admin()): callback: runSocketIO,

    dbpath: [__dirname + /]'.data/',
    bin: '/usr/local/bin/mongod'
  });
  // finally
  api.db -- is MongoClient connected to specified database
 */
var mongodbAPI = {
        client: null,// TODO?: setter, getter
        // methods
        launch: launch_daemon,
        connect: mongodb_connect
    }
    log('^ Mongodb driver version:', mongodb.version)

    return module.exports = mongodbAPI

function launch_daemon(app_api, config){
var cwd, d

    if(!config || !app_api) throw new Error('!Undefined arguments')

    cfg = config
    api = app_api

    if(cfg.stop_on_restart) throw new Error('!Not implementd: "config.stop_on_restart"')

    cwd = cfg.dbpath = __dirname + '/../../../' + cfg.dbpath
    try {
        d = require('fs').statSync(cwd)
    } catch(ex){
        return require('mkdirp').mkdirp(cwd,
        function mkdirp_data_dir(err){
            if(err) throw err

            return spawn_mongod()
        })
    }
    if(!d.isDirectory()){
        throw new Error('Is not a directory: ' + cwd)
    }
    return spawn_mongod()
}

function pad(n){
    return n < 10 ? '0' + n : n
}

function spawn_mongod(){
var cmd, cp, fs

    fs = require('fs')
    cp = require('child_process')

    cmd = new Date
    cfg.log_filename = cfg.dbpath + cmd.getUTCFullYear()
                                   + '-' + pad(cmd.getUTCMonth() + 1) + '.txt'

    cmd = {// check and apply defaults
        bin: cfg.bin,
        // needed options go first, then optional `cfg.cmd_launch` or default
        arg:('--dbpath .' + ' --port ' + (cfg.port || '27727') +
            (cfg.cmd_launch ||
            // optimizations (optional)
            ' --noprealloc --smallfiles ' +
            // basic
            '--journal --directoryperdb --rest --httpinterface --quiet ' +
            // localhost only connection
            '--bind_ip 127.0.0.1')
        ).split(' '),
        opt:{
            cwd: cfg.dbpath,
            detached: true,
            stdio:[
                'ignore'
                ,fs.openSync(cfg.log_filename,'a+')
                ,fs.openSync(cfg.log_filename,'a+')
            ]
        }
    }
    mongod = cp.spawn(cmd.bin, cmd.arg, cmd.opt)
    if(!mongod.pid || mongod.exitCode){
        throw new Error('!FATAL spawn `mongod` exit code: ' + mongod.exitCode)
    }
    mongod.on('close',
    function on_mongod_close(code){
        if(100 == code){// maybe `mongod` is running(lock), or try to restart
            //!!!dev return respawn_mongod_main(cwd)
        } else if(0 != code){// unhandled
            throw new Error('!FATAL close `mongod` exit code: ' + code)
        }
        mongod = void 0// release and flag daemon shutdown
        log('$ `mongod` stop, code: ' + code)
        // `api.db` must receive 'close' event and clean up stuff
        return code
    })
    log('^ `mongod` start pid:', mongod.pid)
    // connect `app` with `db`
    return mongodb_connect()
}

function respawn_mongod_main(){
    throw new Error(
        '!Restart is not impemented. Stop `mongod` manually. Then restart Application.'
    )
}

function mongodb_connect(app_api, config){
   /* Any data in SUPRO transport is being copied globally on every object
    * (or node) of the system, thus `_id`s on every side may collide with
    * locally generated data.
    *
    * So _id's are generated on Mongod's server side and play role only inside
    * local MongoDB.
    *
    * * NOTE: fatal errors and/or crashes inside DB callbacks can not use
    * *       `res.json()` to report UI and that. Timeout will fire in UI
    * *        and `bufferMaxEntries: 0` here
    * */

    if(db){
        return log('Already connected')// permanent `db` setup for app
    }

    if(config && app_api){
        cfg = config
        api = app_api
    }
    // set defaults if needed
    if(!cfg.options) cfg.options = {
        db:{
            forceServerObjectId: true
           ,bufferMaxEntries: 0
           ,journal: true
        }
       ,server:{
            auto_reconnect: true
           /*,socketOptions:{ connectTimeoutMS: 512, socketTimeoutMS: 512 }???*/
        }
    }
    if(!cfg.url) cfg.url = 'mongodb://'+ (cfg.host ||'127.0.0.1') +':'+ (cfg.port ||'27727') +'/'
    if(!cfg.db) cfg.db = 'supro_GLOB'

    if(!cfg.extjs) cfg.extjs = { mongodb_port: 0 }
    if(!cfg.extjs.mongodb_port) cfg.extjs.mongodb_port = cfg.port || 27727// for link
    config = cfg.url + cfg.db
    log('^ db connect:', config)

    return mongodb.MongoClient.connect(
        config, cfg.options, on_connect_app
    )
}//mongodb_connect

function on_connect_app(err ,newdb){
    if(err || !newdb){
        log('!db error MongoClient.connect:', err || '!`newdb`')
        if(!mongod){
            log(
'!db MongoDB damon is not running, it may be db lock, or no free space, etc.\n'+
'see log file: ' + cfg.log_filename
            )
        }
        return setTimeout(mongodb_connect, 4096)
    }

    db = mongodbAPI.client = newdb
    db.on('error', function on_db_err(err){// see NOTE in mongodb_connect()
        db.status = ''
        err && log('!db error: ', err.stack || err)
    })
    db.on('timeout', function on_db_timeout(conn){
        db.status = ''
        conn && log('$ db timeout: ' + conn.host + ':' + conn.port)
    })
    db.on('close', function on_db_close(conn){
        db.status = ''
        conn && log('$ db close: ' + conn.host + ':' + conn.port)
    })

    db.on('reconnect', function on_db_close(conn){
        db_admin()
    })

    // `collection` from the driver is not the only thing we need here
    // there can be other info stored inside this objects e.g. `meta`
    db.getCollection = function getCollection(name){// using cache
        if(!colls_cache[name]){// name is `collectionName`
            colls_cache[name] = db.collection(name)
        }
        return colls_cache[name]
    }
    db.ObjectId = mongodb.ObjectID

    return db_admin()

    function db_admin(){
        return db.admin(function on_admin(aerr ,a){
            if(aerr){
                log('db.admin():', aerr)
                return on_connect_app()// reconnect
            }
            return a.command({ buildInfo: 1 } ,function(e ,d){
                if(e){
                    log('db.admin.command():', e)
                    return on_connect_app()// reconnect
                }
                db.status = "MongoDB v" + d.documents[0]['version']
                log('Connected to ' + db.status)

                api.ctl_on_done && api.ctl_on_done(end_with_mongodb)

                return api.db = db// finally provide `db`
                // TODO: maybe add `callback` for chained setups
                //       now if there is no db due to reconnection or other things
                //       `api.db` checks in API calls/urls just fail
            })
        })//cb admin
    }
}

function end_with_mongodb(next){
    // clean database shutdown and thus app db connection
    if(!api.db){
        log('$ end_with_mongodb(): no `api.db`')
        return next()
    }

    return api.db.admin(
    function get_admin(aerr, a){
        if(aerr){
            log(a = '!mongo db.admin(): ' + aerr)

            return next(aerr)
        }
        return a.command({ shutdown: 1 },
        function on_mongod_shutdown(err, data){
            log('$ MongoDB shutdown data:', data ? data : err ? err : 'nothing')
            // `mongod` shuts down, thus it is not an error:
            //"! MongoDB shutdown command error: [Error: connection closed]"
            return next(err && err.message != 'connection closed' ? err : void 0);
        })
    })
}

})(require, module)
