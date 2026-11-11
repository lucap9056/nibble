package main

import (
	"log"
	"os"
	"router/internal/control"

	"github.com/lucap9056/go-lifecycle/v2/lifecycle"
	"github.com/lucap9056/go-lifecycle/v2/runner"
)

func main() {
	if err := runner.Run(run); err != nil {
		log.Println("router:", err)
		os.Exit(1)
	}
}

func run(lc *lifecycle.Coordinator) error {
	controller := control.NewController(func(err error) {
		lc.Exitln("router: serve failed:", err)
	})
	lc.OnExit(func() {
		if err := controller.Close(true); err != nil {
			log.Println("router: close failed:", err)
		}
	})

	go func() {
		if err := controller.Serve(os.Stdin, os.Stdout); err != nil {
			lc.Exitln("router:", err)
			return
		}
		lc.Exit()
	}()

	return nil
}
