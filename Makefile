CC ?= cc
CFLAGS ?= -O2 -g -std=c11 -Wall -Wextra -Werror -Wpedantic

.PHONY: all clean
all: build/pid1

build/pid1: native/pid1.c
	mkdir -p build
	$(CC) $(CFLAGS) -o $@ $<

clean:
	rm -rf build dist
