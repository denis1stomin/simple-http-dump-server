var os = require('os');
var express = require('express');
var morgan = require('morgan');
var bodyParser = require('body-parser');

var port = 8000;

var app = express();

// Add body parser middleware
app.use(bodyParser.raw({ type: '*/*' }))

// Prepare custom tokens
morgan.token('eol', function (req, res) {
  return os.EOL;
});
morgan.token('req-headers', function (req, res) {
  return JSON.stringify(req.headers);
});
morgan.token('body-text', function (req, res) {
  return req.body;
});

// Add morgan logger middleware
var fmtBlock = `:date[iso] [:remote-addr] - :response-time ms :eol:method :url HTTP/:http-version:eol:req-headers:eol:body-text:eol`
app.use(morgan(fmtBlock));

// Add empty response middleware
app.use(function(req, res) {
  res.writeHead(200);
  res.end();
});

// Start the server
app.listen(port);
console.log(`Listening on port ${port} ...`);

