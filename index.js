#!/usr/bin/env node

var express = require("express"),
  url = require("url"),
  cors = require("cors"),
  path = require('path'),
  fs = require('fs'),
  yaml = require('js-yaml'),
  provider = require('./providers/stateful/simple'),
  app = express();

var smaasJSON = yaml.safeLoad(fs.readFileSync(__dirname + '/smaas.yml','utf8'));

var port = process.env.PORT || 8002;

smaasJSON.host = (process.env.SMAAS_HOST_URL || process.env.HOST || 'localhost') + ':' + port;

// buffer the body
app.use(function(req, res, next) {
  req.body = '';
  req.on('data', function(data) {
    return req.body += data;
  });
  return req.on('end', next);
});

app.set('views', path.join(__dirname, './views'));
app.engine('html', require('ejs').renderFile);
app.use(express.static(path.join(__dirname, './public')));

app.get('/smaas.json', function (req, res) {
  res.status(200).send(smaasJSON);
});

app.get('/api/v1/:StateChartName/:InstanceId/_viz', provider.instanceViz);
app.get('/api/v1/:StateChartName/_viz', provider.statechartViz);
app.all('/api/v1/:StateChartName/_handlers/:HandlerName/*', provider.httpHandlerAction);

Object.keys(smaasJSON.paths).forEach(function(endpointPath){
  var endpoint = smaasJSON.paths[endpointPath];
  var actualPath = smaasJSON.basePath + endpointPath.replace(/{/g, ':').replace(/}/g, '');

  Object.keys(endpoint).forEach(function(methodName){
    var method = endpoint[methodName];

    switch(methodName) {
      case 'get': {
        app.get(actualPath, provider[method.operationId]);
        break;
      }
      case 'post': {
        app.post(actualPath, provider[method.operationId]);
        break;
      }
      case 'put': {
        app.put(actualPath, provider[method.operationId]);
        break;
      }
      case 'delete': {
        app.delete(actualPath, provider[method.operationId]);
        break;
      }
      default:{
        console.log('Unsupported method name:', methodName);
      }
    }
  });
});

app.use(function(req, res, next) {
  res.sendStatus(404).send('Can\'t find ' + req.path);
});

app.listen(port);

