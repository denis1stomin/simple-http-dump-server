var express = require('express');
var morgan = require('morgan');
var bodyParser = require('body-parser');

var port = 8000;

var app = express();

// Add morgan logger middleware
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

// Add simple response middleware
app.use(function(req, res) {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end('Nice to see you again!');
});

// Start the server
app.listen(port);
console.log(`Listening on port ${port} ...`);

