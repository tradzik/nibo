// Useful modules
var path = require('path');
var util = require('util');
// Mustache - easy string templates
var mustache = require('mustache');
// **Kwargs
var kwargs = require('kwargs');
// String
var S = require('string');
// Colors
var colors = require('colors');
// useful debug functions
var debug = require('./debug');

var irc = require('irc');
var config = require('./config.json');

var events = require('./events');

var plugins = [];

// Some config
debug.on = config.debug;

// Inform about error
function showPluginRuntimeError(pluginName, method, exception) {
	var data = {
		plugin: pluginName,
		message: exception.message,
		method: method
	};

	var pattern = 'Module {{&plugin}} runtime error: {{&message}} in callback {{&method}}';
	var output = mustache.render(pattern, data);
	debug.error(output);

	console.log((new Error().stack).magenta);
}

function initPlugins() {
	for (var i in config.plugins) {
		var pluginPath = './' +
			path.join(config.plugins_conf.dir, config.plugins[i]);

		debug.debug('Plugin ' + config.plugins[i] + ' path: ' + pluginPath);

		var tempPlugin;

		try {
			tempPlugin = require(pluginPath);
		} catch (e) {
			var data = {
				plugin: config.plugins[i],
				message: e.message
			};

			var pattern = 'Module {{&plugin}} load error: {{&message}}';
			var output = mustache.render(pattern, data);
			debug.error(output);

			// If module name is wrong don't add that
			continue;
		}

		debug.success('Module: ' + config.plugins[i] + ' loaded');
		plugins.push(tempPlugin);

		try {
			// Init event
			var callback = plugins[i][events.init];
			if (callback)
				callback(bot);

		} catch (e) {
			showPluginRuntimeError(plugins[i].meta.name, events.init, e);
		}
	}

	if (plugins.length > 0) {
		var messageToLog = util.format('Loaded %s modules of %s',
			plugins.length,
			config.plugins.length
		);
		debug.success(messageToLog);
	} else {
		debug.warning('No module of ' + config.plugins.length + ' loaded');
	}
}

function sendCommandResult(result, method, pluginName, args) {
	try {
		var pattern = '{{&nick}}: {{&message}}';
		var message = result.toString(); // Command result
		var data = {
			nick: args.user.nick,
			message: message
		};
		var output = mustache.render(pattern, data);

		bot.say(args.channel, output);
	} catch (e) {
		debug.error('While sending command return message to the user');
		showPluginRuntimeError(method, pluginName, e);
	}
}

function executeCallback(eventName, args) {
	args.bot = bot;
	for (var i in plugins) {
		var result;
		try {
			var callback = plugins[i][eventName];
			if (callback)
				result = kwargs(callback, args);

		} catch (e) {
			showPluginRuntimeError(plugins[i].meta.name, eventName + '()', e);
		}

		if (result && eventName === events.command)
			sendCommandResult(result, eventName, plugins[i].meta.name, args);
	}
}

// Start bot = main function
debug.log('Bot is starting up at the moment..');

var bot = new irc.Client(
	config.server.host,
	config.bot.nick, {
		port: config.server.port,
		channels: config.channels,
		stripColors: true,
		retryCount: 5,
		encoding: true // optional encoding - bug in nodeirc
	}
);

bot.addListener('abort', function (retryCount) {
	var message = util.format('Unable to connect to %s:%s',
		config.server.host,
		config.server.port);

	debug.error(message);
	process.exit();
});

bot.oldsay = bot.say;
bot.say = function (target, message) {
	bot.oldsay(target, message);

	var args = {
		channel: target,
		message: message
	};
	// Bot says - event
	executeCallback(events.botSay, args);
};

initPlugins();

bot.getUser = function (message) {
	if (!message) {
		debug.warning('bot.getUser() requires 1 argument, 0 given');
		return;
	}

	var user = {
		nick: message.nick,
		username: message.user,
		host: message.host,
		fullName: util.format('%s!%s@%s',
			message.nick,
			message.user,
			message.host
		)
	};

	// The object may be incomplete

	return user;
};

bot.addListener('topic', function (channel, topic, nick, message) {
	/*
		If bot joins        nick = full user name e.g 'niboman!~op@ophost.eu'
		If op changes topic nick = op nick        e.g 'niboman'
	*/

	var args = {
		channel: channel,
		topic: topic,
		nick: nick,
		message: message
	};

	executeCallback(events.topic, args);
});

bot.addListener('join', function (channel, nick, message) {
	if (nick == bot.nick) {
		executeCallback(events.botJoin, {
			channel: channel
		});
		return;
	}
	var user = bot.getUser(message);

	// If user join to the channel
	executeCallback(events.userJoin, {
		channel: channel,
		user: user
	});
});

function splitCommand(str, prefix) {
	var withoutPrefix = str.split(prefix)[1]; // 'command arg1 arg2'
	var splitted = withoutPrefix.split(' '); // ['command', 'arg1', 'arg2']
	var command = {
		name: splitted[0], //
		args: splitted.slice(1) // ['arg1', 'arg2']
	};

	return command;
}

function executeCommand(user, channel, message) {
	var command = splitCommand(message, config.commandPrefix);
	var args = {
		user: user,
		channel: channel,
		command: command
	};

	executeCallback(events.command, args);
}

bot.addListener('message', function (nick, channel, text, message) {
	var user = bot.getUser(message);
	var args = {
		user: user,
		channel: channel,
		message: message.args[1]
	};

	var isCommand = S(args.message).startsWith(config.commandPrefix);
	if (isCommand) {
		executeCommand(args.user, args.channel, args.message);
		return;
	}

	executeCallback(events.message, args);
});

bot.addListener('nick', function (oldnick, newnick, userChannels, message) {
	var user = bot.getUser(message);
	user.nick = newnick; // nick is newnick!
	user.oldnick = oldnick;

	var args = {
		user: user,
		channels: userChannels,
	};

	executeCallback(events.nick, args);
});

bot.addListener('part', function (channel, nick, reason, message) {
	var user = bot.getUser(message);
	var args = {
		channel: channel,
		user: user,
		reason: reason
	};

	executeCallback(events.part, args);
});

bot.addListener('quit', function (nick, reason, channels, message) {
	var user = bot.getUser(message);
	var args = {
		user: user,
		channels: channels,
		reason: reason
	};

	executeCallback(events.quit, args);
});

bot.addListener('kick', function (channel, nick, by, reason, message) {
	var args = {
		nick: nick,
		by: by,
		channel: channel,
		reason: reason
	};

	executeCallback(events.kick, args);
});

function modeEvent(channel, by, mode, target, type) {
	var args = {
		channel: channel,
		by: by,
		mode: type + mode, // e.g '+m' or '-b'
		target: target // user or undefined if +mode is performed on channel
	};

	executeCallback(events.mode, args);
}

bot.addListener('+mode', function (channel, by, mode, argument, message) {
	modeEvent(channel, by, mode, argument, '+');
});

bot.addListener('-mode', function (channel, by, mode, argument, message) {
	modeEvent(channel, by, mode, argument, '-');
});

bot.addListener('notice', function (channel, to, text, message) {
	var args = {
		channel: channel, // If notice from server - channel = undefined, if notice from user = nick (from)
		to: to, // channel or user
		text: text, // notice message
	};

	executeCallback(events.notice, args);
});

function tickEvent() {
	executeCallback(events.tick, {});
	/*	By setting new timeout
		I have more control
	*/
	setTimeout(tickEvent, config.tickTime);
}

// Setup tick event
setTimeout(tickEvent, config.tickTime);

bot.addListener('invite', function (channel, from, message) {
	if (config.joinOnInvite)
		bot.join(channel);
});