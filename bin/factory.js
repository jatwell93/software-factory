#!/usr/bin/env node
/**
 * The factory's one command: `factory <init|doctor|upgrade|new-change|cleanup> [args]`.
 * It runs the matching script from this checkout, in the current directory, so a
 * project never needs the script's path. Run `factory help` for the list.
 *
 * Without installing: node <path-to-software-factory>/bin/factory.js doctor
 */

const { runFrontDoor } = require('../lib/front-door.js');

process.exitCode = runFrontDoor(process.argv.slice(2));
