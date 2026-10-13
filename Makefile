.PHONY: build test

BIN := bin/gandalf

build:
	@mkdir -p bin
	go build -o $(BIN) ./cmd/gandalf

test:
	go test -count=1 ./...
