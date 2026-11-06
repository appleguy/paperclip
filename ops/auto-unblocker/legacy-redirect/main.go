// The operational directory retains this entry point for existing callers.
// Keep policy and implementation in the reviewed repository copy.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

func main() {
	const source = "/Volumes/NVM/Paperclip/master/ops/auto-unblocker"
	goPath, err := exec.LookPath("go")
	if err == nil {
		err = os.Chdir(source)
	}
	if err == nil {
		args := append([]string{goPath, "run", "."}, os.Args[1:]...)
		err = syscall.Exec(goPath, args, os.Environ())
	}
	fmt.Fprintf(os.Stderr, "auto-unblocker redirect: %v\n", err)
	os.Exit(1)
}
