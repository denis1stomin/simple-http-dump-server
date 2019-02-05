# Simple HTTP requests dump server

Very simple nodejs HTTP server which dumps all incoming HTTP requests to standard output stream.
It can help you to research a 3rd party service webhooks structure without "deep diving" into the service documentation.
For example you can easily take a look at GitHub webhook payload data and request headers.
Kinda primitive version of RequestBin service which you can run inside docker container.

## Run as docker container

* `docker pull denis1stomin/simple-http-dump-server` (download [docker image](https://hub.docker.com/r/denis1stomin/simple-http-dump-server/))
* `docker run -p 8080:8000 --name httpdump denis1stomin/simple-http-dump-server` (run container instance)

Since the container instance is run in attached mode you can see its output right in the Terminal.
By default the service is started on 8000 port inside container.
In the example command above `8080` port is exposed to OS.

Run `curl -X POST "http://localhost:8080/some/path" -d "{\"SomeProp\": \"value\"}"` from another Terminal window.
And you will see POST request details like:
```
2018-06-07T21:07:50.988Z [::ffff:172.17.0.1] - 0.852 ms 
POST /some/path HTTP/1.1
{"host":"localhost:8080","user-agent":"curl/7.55.1","accept":"*/*","content-length":"23","content-type":"application/x-www-form-urlencoded"}
{"SomeProp": "value"}
```

## Run using Azure Container Instances service

In the case you need publicly available URI you can run it as Azure Container Instance.

* `az group create --name http-dump --location centralus` (create resource group)
* `CONTAINER_DNS_NAME=$(uuidgen)` (define unique DNS name label)
* `# az container create --help` (you can customize the command below)
* `az container create --name http-dump-server --resource-group http-dump --ip-address public --image denis1stomin/simple-http-dump-server --ports 8000 --dns-name-label $CONTAINER_DNS_NAME` (create and run container instance)
* `az container attach --name http-dump-server --resource-group http-dump` (connect to container standard output)

Make test request from another Terminal window.
* `TEST_URI=http://$CONTAINER_DNS_NAME.centralus.azurecontainer.io:8000/some/path`
* `curl $TEST_URI`


## Download and run NPM package

TODO

## Run the code from GitHub repository

* `git clone https://github.com/denis1stomin/simple-http-dump-server.git` (clone the repository)
* `cd simple-http-dump-server && npm start` (run the server)

