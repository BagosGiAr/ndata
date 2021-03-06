var ndata = require('../index');

var server = ndata.createServer(9000);
var clientA = ndata.createClient(9000);

var val = 'This is a value';

clientA.set(['a', 'b', 'c'], val, true, function(err, value) {
	console.log('set with getVal set to true 1:', value);
});

clientA.set(['d', 'e', 'f'], val, function(err, value) {
	console.log('set with getVal not set 1:', value);
});

clientA.add(['g', 'h', 'i'], 'append this', function(err, value) {
	clientA.get(['g', 'h', 'i', 0], function(err, value) {
		console.log('add 1:', value);
		
		clientA.concat(['g', 'h', 'i'], [1,2,3,4], function(err, value) {
			clientA.get(['g', 'h', 'i'], function(err, value) {
				console.log('concat 1:', value);
				clientA.concat(['g', 'h', 'i'], {one: 1, two: 2, three: 3}, function(err, value) {
					clientA.get(['g', 'h', 'i'], function(err, value) {
						console.log('concat 2:', value);
					});
				});
			});
		});
	});
});

clientA.set(['m', 'n', 'o'], {one: 1, two: 2, three: 3, four: 4, five: 5}, function(err) {
	clientA.removeRange(['m', 'n', 'o'], 'two', 'four', function(err, value) {
		clientA.get(['m', 'n', 'o'], function(err, value) {
			console.log('removeRange 1:', value);
		});
	});
});

clientA.set(['p', 'q'], [0,1,2,3,4,5,6,7,8], function(err) {
	clientA.removeRange(['p', 'q'], 3, 6, function(err, value) {
		clientA.get(['p', 'q'], function(err, value) {
			console.log('removeRange 2:', value);
		});
	});
});

clientA.set(['one', 'two', 'three', 'four'], val, function(err) {
	var query = function(DataMap) {return DataMap.get(['one', 'two', 'three']);};
	
	clientA.run(query, function(err, value) {
		console.log('run 1:', value);
	});
});

var obj = {
	x: 1,
	y: 2
};
var query = function(DataMap) {
	DataMap.set('point', point);
	return DataMap.get(['point']);
};
query.data = {
	point: obj
};

clientA.run(query, function(err, value) {
	console.log('run 2:', value);
});

var arr = [0, 1, 2, 3, 4, 5, 6, 7];
var obj = {red: 1, green: 2, blue: 3, yellow: 4, orange: 5};

clientA.set(['this', 'is', 'an', 'array'], arr, function(err) {
	clientA.getRange(['this', 'is', 'an', 'array'], 2, 5, function(err, value) {
		console.log('getRange 1:', value);
	});
	
	clientA.getRange(['this', 'is', 'an', 'array'], 4, function(err, value) {
		console.log('getRange 2:', value);
	});
	
	clientA.getRange(['this', 'is', 'an', 'array'], 0, 5, function(err, value) {
		console.log('getRange 3:', value);
	});
	
	clientA.getRange(['this', 'is', 'an', 'array'], 4, 15, function(err, value) {
		console.log('getRange 4:', value);
	});
});

clientA.set(['this', 'is', 'an', 'object'], obj, function(err) {
	clientA.getRange(['this', 'is', 'an', 'object'], 'green', 'blue', function(err, value) {
		console.log('getRange 5:', value);
	});
	
	clientA.getRange(['this', 'is', 'an', 'object'], 'blue', function(err, value) {
		console.log('getRange 6:', value);
	});
	
	clientA.getRange(['this', 'is', 'an', 'object'], 'green', 'yellow', function(err, value) {
		console.log('getRange 7:', value);
	});
});

clientA.set(['that', '8a788b9c-c50e-0b3f-bd47-ec0c63327bf1'], [1,2,3,4,5], function(err) {
	clientA.set(['that', '8a788b9c-c50e-0b3f-bd47-ec0c63327bf1'], [6,7,8], function(err) {
		clientA.get('that', function(err, value) {
			console.log('get 1:', value);
		});
	});
});

clientA.set(['check', 'expire', 'key'], 'some data', function(err) {
	clientA.expire([['check', 'expire', 'key']], 5);
	setTimeout(function () {
		clientA.get(['check'], function(err, value) {
			console.log('expire 1:', value);
		});
	}, 11000);
});