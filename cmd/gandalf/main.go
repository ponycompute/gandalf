package main

import (
	"os"

	"github.com/qyinm/gandalf/internal/cli"
)

func main() {
	os.Exit(cli.Execute())
}
