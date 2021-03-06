var fork = require('child_process').fork;
var EventEmitter = require('events').EventEmitter;
var ComSocket = require('ncom').ComSocket;
var FlexiMap = require('fleximap').FlexiMap;
var domain = require('domain');

var DEFAULT_PORT = 9435;
var HOST = '127.0.0.1';

var Server = function (port, secretKey, expiryAccuracy) {
	EventEmitter.call( this );
	var self = this;

	var args = Array.prototype.slice.call(arguments).filter(function(arg) { return !!arg; });
	
	self._server = fork(__dirname + '/server.js', args);
	
	self._server.on('message', function (value) {
		if (value.event == 'listening') {
			self.emit('ready');
		} else if (value.event == 'error') {
			var err;
			if (value.data && value.data.message) {
				err = new Error();
				err.message = value.data.message;
				err.stack = value.data.stack;
			} else {
				err = value.data;
			}
			self.emit('error', err);
		}
	});
	
	self._server.on('exit', function (code, signal) {
		self.emit('exit', code, signal);
	});
	
	self.destroy = function () {
		self._server.kill();
	};
};

Server.prototype = Object.create(EventEmitter.prototype);

module.exports.createServer = function (port, secretKey, expiryAccuracy) {
	if (!port) {
		port = DEFAULT_PORT;
	}
	return new Server(port, secretKey, expiryAccuracy);
};

var Client = function (port, host, secretKey, timeout) {
	var self = this;
	self._errorDomain = domain.createDomain();
	
	self._errorDomain.on('error', function (err) {
		self.emit('error', err);
	});
	
	secretKey = secretKey || null;
	if (timeout) {
		self._timeout = timeout;
	} else {
		self._timeout = 10000;
	}
	
	var maxRetries = 4;
	var retryCount = 0;
	var retryInterval = 1000;
	
	self._watchMap = new FlexiMap();
	self._commandMap = {};
	self._pendingActions = [];
	
	self._socket = new ComSocket();
	self._connected = false;
	
	self._curID = 1;
	self.MAX_ID = Math.pow(2, 53) - 2;
	
	self.setMaxListeners(0);
	
	self._genID = function () {
		self._curID = (self._curID + 1) % self.MAX_ID;
		return 'n' + self._curID;
	};
	
	self._broadcast = function (event, value) {
		if (self._watchMap.hasKey(event)) {
			var watchers = self._watchMap.get(event);
			for (var i in watchers) {
				if (watchers[i] instanceof Function) {
					watchers[i](value);
				}
			}
		}
	};
	
	self._execPending = function () {
		for (var i in self._pendingActions) {
			self._exec.apply(self, self._pendingActions[i]);
		}
		self._pendingActions = [];
	};
	
	self._connectHandler = function () {
		if (secretKey) {
			var command = {
				action: 'init',
				secretKey: secretKey
			};
			self._connected = true;
			self._exec(command, function (data) {
				self._execPending();
				self.emit('ready');
			});
		} else {
			self._connected = true;
			self._execPending();
			self.emit('ready');
		}
	};
	
	self._connect = function () {
		self._socket.connect(port, host, self._connectHandler);
	};
	
	var handleError = function () {
		self._connected = false;
		if (++retryCount <= maxRetries) {
			setTimeout(self._connect, retryInterval);
		} else {
			self.emit('connect_failed');
		}
	};
	
	self._socket.on('error', handleError);
	
	self._socket.on('message', function (response) {
		var id = response.id;
		var error = response.error || null;
		if (response.type == 'response') {
			if (self._commandMap.hasOwnProperty(id)) {
				clearTimeout(self._commandMap[id].timeout);
				var action = response.action;
				
				var callback = self._commandMap[id].callback;
				delete self._commandMap[id];
				
				if (response.value !== undefined) {
					callback(error, response.value);
				} else if (action == 'watch' || action == 'unwatch') {
					callback(error);
				} else {
					callback(error);
				}
			}
		} else if (response.type == 'event') {
			self._broadcast(response.event, response.value);
		}
	});
	
	self._connect();
	
	self._exec = function (command, callback) {
		if (self._connected) {
			command.id = self._genID();
			if (callback) {
				callback = self._errorDomain.bind(callback);
				var request = {callback: callback, command: command};
				self._commandMap[command.id] = request;

				request.timeout = setTimeout(function () {
					var error = 'nData Error - The ' + command.action + ' action timed out';
					delete request.callback;
					if (self._commandMap.hasOwnProperty(command.id)) {
						delete self._commandMap[command.id];
					}
					callback(error);
				}, self._timeout);
			}
			self._socket.write(command);
		} else {
			self._pendingActions.push(arguments);
		}
	};
	
	self.extractKeys = function (object) {
		return Object.keys(object);
	};
	
	self.extractValues = function (object) {
		var array = [];
		for (var i in object) {
			array.push(object[i]);
		}
		return array;
	};
	
	self.watch = function (event, handler, ackCallback) {
		var command = {
			event: event,
			action: 'watch'
		};
	
		var callback = function (err) {
			if (err) {
				ackCallback && ackCallback(err);
				self.emit('watchfail');
			} else {
				self._watchMap.add(event, self._errorDomain.bind(handler));
				ackCallback && ackCallback();
				self.emit('watch');
			}
		};
		self._exec(command, callback);
	};
	
	self.watchOnce = function (event, handler, ackCallback) {
		if (self.isWatching(event)) {
			if (ackCallback) {
				self._errorDomain.run(function () {
					ackCallback();
				});
			}
			self.emit('watch');
		} else {
			self.watch(event, handler, ackCallback);
		}
	};
	
	self.watchExclusive = function (event, handler, ackCallback) {
		var command = {
			event: event,
			action: 'watchExclusive'
		};
	
		var callback = function (err, alreadyWatching) {
			if (err) {
				if (ackCallback) {
					self._errorDomain.run(function () {
						ackCallback(err, alreadyWatching);
					});
				}
				self.emit('watchfail');
			} else {
				if (!alreadyWatching) {
					self._watchMap.add(event, self._errorDomain.bind(handler));
				}
				if (ackCallback) {
					self._errorDomain.run(function () {
						ackCallback(null, alreadyWatching);
					});
				}
				self.emit('watch');
			}
		};
		self._exec(command, callback);
	};
	
	self.isWatching = function (event, handler) {
		if (handler) {
			return self._watchMap.hasValue(event, handler);
		} else {
			return self._watchMap.hasKey(event);
		}
	};
	
	self._unwatch = function (event, callback) {
		var command = {
			action: 'unwatch',
			event: event
		};
		
		var cb = function (error) {
			if (error) {
				callback && callback(error);
				self.emit('unwatchfail');
			} else {
				callback && callback();
				self.emit('unwatch');
			}
		};
		
		self._exec(command, cb);
	};
	
	self.unwatch = function (event, handler, ackCallback) {
		if (event) {
			if (self._watchMap.hasKey(event)) {
				if (handler) {
					var newWatchers = [];
					var watchers = self._watchMap.get(event);
					for (var i in watchers) {
						if (watchers[i] != handler) {
							newWatchers.push(watchers[i]);
						}
					}
					
					var callback = function (err) {
						if (!err) {
							self._watchMap.set(event, newWatchers);
						}
						if (self._watchMap.count(event) < 1) {
							self._watchMap.remove(event);
						}
						ackCallback && ackCallback(err);
					};
					
					if (newWatchers.length < 1) {
						self._unwatch(event, callback);
					} else {
						self._watchMap.set(event, newWatchers);
						if (self._watchMap.count(event) < 1) {
							self._watchMap.remove(event);
						}
						ackCallback && ackCallback();
					}
				} else {
					var callback = function (err) {
						if (!err) {
							self._watchMap.remove(event);
						}
						ackCallback && ackCallback(err);
					};
					self._unwatch(event, callback);
				}
			} else {
				self._unwatch(event, ackCallback);
			}
		} else {
			self._watchMap.removeAll();
			self._unwatch(null, ackCallback);
		}
	};
	
	self.broadcast = function () {
		var event = arguments[0];
		var value = null;
		var callback = null;
		if (arguments[1] instanceof Function) {
			callback = arguments[1];
		} else {
			value = arguments[1];
			callback = arguments[2];
		}
		
		var command = {
			action: 'broadcast',
			event: event,
			value: value
		};
		
		self._exec(command, callback);
	};
	
	/*
		set(key, value,[ options, callback])
	*/
	self.set = function () {
		var key = arguments[0];
		var value = arguments[1];
		var options = {
			getValue: 0
		};
		var callback;
		
		if (arguments[2] instanceof Function) {
			callback = arguments[2];
		} else {
			options.getValue = arguments[2];
			callback = arguments[3];
		}
		
		var command = {
			action: 'set',
			key: key,
			value: value
		};
		
		if (options.getValue) {
			command.getValue = 1;
		}
		
		self._exec(command, callback);
	};
	
	/*
		expire(keys, seconds,[ callback])
	*/
	self.expire = function (keys, seconds, callback) {
		var command = {
			action: 'expire',
			keys: keys,
			value: seconds
		};
		self._exec(command, callback);
	};
	
	/*
		unexpire(keys,[ callback])
	*/
	self.unexpire = function (keys, callback) {
		var command = {
			action: 'unexpire',
			keys: keys
		};
		self._exec(command, callback);
	};
	
	/*
		getExpiry(key,[ callback])
	*/
	self.getExpiry = function (key, callback) {
		var command = {
			action: 'getExpiry',
			key: key
		};
		self._exec(command, callback);
	};
	
	/*
		add(key, value,[ options, callback])
	*/
	self.add = function () {
		var key = arguments[0];
		var value = arguments[1];
		var options = {
			getValue: 0
		};
		var callback;
		if (arguments[2] instanceof Function) {
			callback = arguments[2];
		} else {
			options.getValue = arguments[2];
			callback = arguments[3];
		}
		
		var command = {
			action: 'add',
			key: key,
			value: value
		};
		
		if (options.getValue) {
			command.getValue = 1;
		}
		
		self._exec(command, callback);
	};
	
	/*
		concat(key, value,[ options, callback])
	*/
	self.concat = function () {
		var key = arguments[0];
		var value = arguments[1];
		var options = {
			getValue: 0
		};
		var callback;
		if (arguments[2] instanceof Function) {
			callback = arguments[2];
		} else {
			options.getValue = arguments[2];
			callback = arguments[3];
		}
		
		var command = {
			action: 'concat',
			key: key,
			value: value
		};
		
		if (options.getValue) {
			command.getValue = 1;
		}
		
		self._exec(command, callback);
	};
	
	self.get = function (key, callback) {
		var command = {
			action: 'get',
			key: key	
		};
		self._exec(command, callback);
	};
	
	/*
		getRange(key, fromIndex,[ toIndex,] callback)
	*/
	self.getRange = function () {
		var key = arguments[0];
		var fromIndex = arguments[1];
		var toIndex = null;
		var callback;
		if (arguments[2] instanceof Function) {
			callback = arguments[2];
		} else {
			toIndex = arguments[2];
			callback = arguments[3];
		}
		
		var command = {
			action: 'getRange',
			key: key,
			fromIndex: fromIndex
		};
		
		if (toIndex) {
			command.toIndex = toIndex;
		}
		
		self._exec(command, callback);
	};
	
	self.getAll = function (callback) {
		var command = {
			action: 'getAll'
		};
		self._exec(command, callback);
	};
	
	self.count = function (key, callback) {
		var command = {
			action: 'count',
			key: key
		};
		self._exec(command, callback);
	};
	
	self._stringifyQuery = function (query, data) {
		query = query.toString();
		query = query.replace(/[\t ]+/g, ' ').replace(/[\r\n]+ ?/g, ' ');
		
		var validVarNameRegex = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
		var headerString = '';
		
		for (var i in data) {
			if (!validVarNameRegex.test(i)) {
				throw new Error("The variable name '" + i + "' is invalid");
			}
			headerString += 'var ' + i + '=' + JSON.stringify(data[i]) + ';';
		}
		
		query = query.replace(/^(function *[(][^)]*[)] *{)/, '$1' + headerString);
		
		return query;
	};
	
	/*
		registerDeathQuery(query,[ data, callback])
	*/
	self.registerDeathQuery = function () {
		var data;
		var callback = null;
		
		if (arguments[1] instanceof Function) {
			data = arguments[0].data || {};
			callback = arguments[1];
		} else if (arguments[1]) {
			data = arguments[1];
			callback = arguments[2];
		} else {
			data = arguments[0].data || {};
		}
		
		var query = self._stringifyQuery(arguments[0], data);
		
		if (query) {
			var command = {
				action: 'registerDeathQuery',
				value: query
			};
			self._exec(command, callback);
		} else {
			callback && callback('Invalid query format - Query must be a string or a function');
		}
	};
	
	/*
		run(query,[ options, callback])
	*/
	self.run = function () {
		var data;
		var baseKey = null;
		var noAck = null;
		var callback = null;
		
		if (arguments[0].data) {
			data = arguments[0].data;
		} else {
			data = {};
		}
		
		if (arguments[1] instanceof Function) {
			callback = arguments[1];
		} else if (arguments[1]) {
			baseKey = arguments[1].baseKey;
			noAck = arguments[1].noAck;
			if (arguments[1].data) {
				data = arguments[1].data;
			}
			callback = arguments[2];
		}
		
		var query = self._stringifyQuery(arguments[0], data);
		
		if (query) {			
			var command = {
				action: 'run',
				value: query
			};
			
			if (baseKey) {
				command.baseKey = baseKey;
			}
			if (noAck) {
				command.noAck = noAck;
			}
			
			self._exec(command, callback);
		} else {
			callback && callback('Invalid query format - Query must be a string or a function');
		}
	};
	
	/*
		query(query,[ data, callback])
	*/
	self.query = function () {
		if (arguments[1] && !(arguments[1] instanceof Function)) {
			var options = {data: arguments[1]};
			self.run(arguments[0], options, arguments[2]);
		} else {
			self.run.apply(self, arguments);
		}		
	};
	
	/*
		remove(key,[ options, callback])
	*/
	self.remove = function () {
		var key = arguments[0];
		var options = {
			getValue: 0
		};
		var callback;
		if (arguments[1] instanceof Function) {
			callback = arguments[1];
		} else {
			if (arguments[1] instanceof Object) {
				options = arguments[1];
			} else {
				options.getValue = arguments[1];
			}
			callback = arguments[2];
		}
		
		var command = {
			action: 'remove',
			key: key
		};
		
		if (options.getValue) {
			command.getValue = 1;
		}
		if (options.noAck) {
			command.noAck = 1;
		}
		
		self._exec(command, callback);
	};
	
	/*
		removeRange(key, fromIndex,[ options, callback])
	*/
	self.removeRange = function () {
		var key = arguments[0];
		var fromIndex = arguments[1];
		var options = {
			toIndex: null,
			getValue: 0
		};
		var callback;
		if (arguments[2] instanceof Function) {
			callback = arguments[2];
		} else if (arguments[3] instanceof Function) {
			options = arguments[2];
			callback = arguments[3];
		} else {
			options.toIndex = arguments[2];
			options.getValue = arguments[3];
			callback = arguments[4];
		}
		
		var command = {
			action: 'removeRange',
			fromIndex: fromIndex,
			key: key
		};
		
		if (options.toIndex) {
			command.toIndex = options.toIndex;
		}
		if (options.getValue) {
			command.getValue = 1;
		}
		if (options.noAck) {
			command.noAck = 1;
		}
		
		self._exec(command, callback);
	};
	
	self.removeAll = function (callback) {
		var command = {
			action: 'removeAll'
		};
		self._exec(command, callback);
	};
	
	/*
		pop(key,[ options, callback])
	*/
	self.pop = function () {
		var key = arguments[0];
		var options = {
			getValue: 0
		};
		var callback;
		if (arguments[1] instanceof Function) {
			callback = arguments[1];
		} else {
			options.getValue = arguments[1];
			callback = arguments[2];
		}
		
		var command = {
			action: 'pop',
			key: key
		};
		if (options.getValue) {
			command.getValue = 1;
		}
		if (options.noAck) {
			command.noAck = 1;
		}
		
		self._exec(command, callback);
	};
	
	self.hasKey = function (key, callback) {
		var command = {
			action: 'hasKey',
			key: key
		};
		self._exec(command, callback);
	};
	
	self.end = function (callback) {
		self.unwatch(null, null, function () {
			if (callback) {
				var disconnectCallback = function () {
					if (disconnectTimeout) {
						clearTimeout(disconnectTimeout);
					}
					callback();
					self._socket.removeListener('end', disconnectCallback);
				};
				
				var disconnectTimeout = setTimeout(function () {
					self._socket.removeListener('end', disconnectCallback);
					callback('Disconnection timed out');
				}, self._timeout);
				
				self._socket.on('end', disconnectCallback);
			}
			var setDisconnectStatus = function () {
				self._socket.removeListener('end', setDisconnectStatus);
				self._connected = false;
			};
			self._socket.on('end', setDisconnectStatus);
			self._socket.end();
		});
	};
};

Client.prototype = Object.create(EventEmitter.prototype);

module.exports.createClient = function (port, secretKey) {
	if (!port) {
		port = DEFAULT_PORT;
	}
	return new Client(port, HOST, secretKey);
};