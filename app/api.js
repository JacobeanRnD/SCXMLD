'use strict';

var uuid = require('uuid');
var sse = require('./sse');
var util = require('./util');
var debug = require('debug')('scxmld');

module.exports = function (simulation, db) {
  var api = {};

  function createInstance(instanceId, done){
    simulation.createInstance(instanceId, function (err, instanceId) {
      debug('simulation.createInstance response', instanceId, null);
      db.saveInstance(instanceId, null, function () {
        done(err, instanceId);
      });
    });
  }

  api.createInstance = function(req, res) {
    api.createNamedInstance(req, res);
  };

  api.createNamedInstance = function(req, res) {
    db.getInstance(req.params.InstanceId, function (err, exists) {
      if(exists) return res.status(409).send({ name: 'error.creating.instance', data: { message: 'InstanceId is already associated with an instance' }});

      createInstance(req.params.InstanceId, function (err, instanceId) {
        if (!util.IsOk(err, res)) return;
        if(err && err.statusCode === 404) return res.status(404).send({ name: 'error.getting.statechart', data: { message: 'Statechart definition not found' }});

        res.setHeader('Location', instanceId);

        res.status(201).send({ name: 'success.create.instance', data: { id: instanceId }});
      });
    });
  };

  api.getInstances = function(req, res) {
    db.getInstances(function (err, instances) {
      if (!util.IsOk(err, res)) return;

      instances = instances.map(function (id) {
        return { id: id.split('/')[1] };
      });

      res.send({ name: 'success.get.instances', data: { instances: instances }});
    });
  };

  api.getInstance = function(req, res){
    var instanceId = util.getInstanceId(req);

    db.getInstance(instanceId, function (err, snapshot) {
      if (!util.IsOk(err, res)) return;

      res.send({ name: 'success.get.instance', data: { instance: { snapshot: snapshot }}});
    });
  };

  function sendEvent (instanceId, event, sendOptions, eventUuid, done) {
    simulation.sendEvent(instanceId, event, sendOptions, eventUuid, function (err, conf) {
      if(err) return done(err);

      db.saveInstance(instanceId, conf, function () {
        if(err) return done(err);

        db.saveEvent(instanceId, {
          timestamp: new Date(),
          event: event,
          snapshot: conf
        }, function (err) {
          done(err, conf[0]);
        });
      });
    }, respond);
  }

  var eventQueue = {};
  var isProcessing = false;

  api.sendEvent = function(req, res) {
    var instanceId = util.getInstanceId(req),
      event;

    try {
       event = JSON.parse(req.body);
    } catch(e) {
      return res.status(400).send({ name: 'error.parsing.json', data: { message: 'Malformed event body.' }});
    }

    // Queue logic:
    //
    // push event to queue
    // start processing
    //
    // If process is busy, do nothing
    // completed process will dequeue the next event

    var queue = eventQueue[instanceId] = eventQueue[instanceId] || [];

    queue.push([event, res]);
    processEventQueue();

    function processEventQueue () {
      if(isProcessing || queue.length === 0) return;

      isProcessing = true;
      var eventUuid = uuid.v1(); //tag him with a uuid

      var tuple = queue.shift();

      var event = tuple[0],
          res = tuple[1];

      db.getInstance(instanceId, function (err) {
        if(err) {
          isProcessing = false;
          return res.status(err.statusCode || 500).send(err);
        }

        var sendOptions = {
          uri: req.protocol + '://' + req.get('Host') + req.url,
          method: req.method
        };

        if(req.headers.authorization) {
          sendOptions.headers = {
            Authorization: req.headers.authorization
          };
        }

        if(req.cookies) {
          sendOptions.cookies = req.cookies;
        }

        pendingResponses[eventUuid] = res;   //save the response

        sendEvent(instanceId, event, sendOptions, eventUuid, function (err) {
          isProcessing = false;

          if (!util.IsOk(err, res)) return;

          processEventQueue();
        });
      });
    }
  };

  var pendingResponses = {};

  function respond(eventUuid, snapshot, customData){
    var res = pendingResponses[eventUuid];
    if(!res) return;      //this can happen if, for example, 
                          //the server dies before the response has been released
    if(snapshot){
      res.setHeader('X-Configuration',JSON.stringify(snapshot[0]));
      res.send({ name: 'success.event.sent', data: { snapshot: snapshot[0] }});
    }else{
      var statusCode = customData.error ? 500 : 200;
      res.send(statusCode, customData);
    }
    delete pendingResponses[eventUuid];
  }

  function deleteInstance (instanceId, done) {
    simulation.unregisterAllListeners(instanceId, function () {
      //Delete event queue for the specific instance
      eventQueue[instanceId] = [];
      
      simulation.deleteInstance(instanceId, function (err) {
        if(err) return done(err);

        db.deleteInstance(instanceId, done);
      });
    });
  }

  api.deleteInstance = function(req, res){
    var instanceId = util.getInstanceId(req);

    simulation.unregisterListener(instanceId, res, function(err){
      if (!util.IsOk(err, res)) return;

      deleteInstance(instanceId, function (err) {
        if (!util.IsOk(err, res)) return;

        res.send({ name: 'success.deleting.instance', data: { message: 'Instance deleted successfully.' }});
      });
    });
  };

  api.getInstanceChanges = function(req, res){
    var instanceId = util.getInstanceId(req);

    simulation.registerListener(instanceId, res, function () {
      sse.initStream(req, res, function(){
        simulation.unregisterListener(instanceId, res, function(){});
      });
    });
  };

  api.instanceViz = function (req, res) {
    var instanceId = util.getInstanceId(req);

    db.getInstance(instanceId, function (err, exists) {
      if(typeof exists === 'undefined') return res.sendStatus(404);

      res.render('viz.html', {
        type: 'instance'
      });
    });
  };

  api.statechartViz = function (req, res) {
    res.render('viz.html', {
      type: 'statechart'
    });
  };

  api.getEventLog = function (req, res) {
    var instanceId = util.getInstanceId(req);

    db.getEvents(instanceId, function (err, events) {
      if (!util.IsOk(err, res)) return;

      res.send({ name: 'success.getting.logs', data: { events: events }});
    });
  };

  return api;
};
