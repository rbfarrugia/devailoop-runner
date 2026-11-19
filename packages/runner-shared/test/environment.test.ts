import { describe, expect, it } from 'vitest';
import { MAX_ENVIRONMENT_LENGTH, environmentImageTag, environmentProblem, isEnvironmentImageOf } from '../src';

const godot = [
  'FROM devailoop-agent-base',
  'USER root',
  'RUN apt-get update && apt-get install -y --no-install-recommends unzip',
  'USER agent',
].join('\n');

describe("an Environment's Dockerfile", () => {
  it.each([
    ['the usual form', godot],
    ['comments and blank lines first', `# Godot for the tests\n\n${godot}`],
    ['the latest tag, in any case', 'from devailoop-agent-base:latest\nRUN true'],
    ['a continued instruction', 'FROM devailoop-agent-base\nRUN apt-get update \\\n # a comment\n && true'],
    ['files from another image', 'FROM devailoop-agent-base\nCOPY --from=golang:1.24 /usr/local/go /usr/local/go'],
  ])('accepts %s', (_name, dockerfile) => {
    expect(environmentProblem(dockerfile)).toBeNull();
  });

  it.each([
    ['nothing', ''],
    ['another base', 'FROM ubuntu:24.04'],
    ['an argument before FROM', 'ARG BASE=devailoop-agent-base\nFROM ${BASE}'],
    ['a platform', 'FROM --platform=linux/amd64 devailoop-agent-base'],
    ['a named stage', 'FROM devailoop-agent-base AS tools'],
    ['the base by another tag', 'FROM devailoop-agent-base:old'],
  ])('refuses one that does not start with FROM devailoop-agent-base: %s', (_name, dockerfile) => {
    expect(environmentProblem(dockerfile)).toMatch(/must start with "FROM devailoop-agent-base"/);
  });

  it('refuses a second FROM, which would make the image something else', () => {
    expect(environmentProblem(`${godot}\nFROM ubuntu:24.04`)).toMatch(/only one FROM/);
    expect(environmentProblem(`${godot}\nRUN true \\\n  && true\n  from ubuntu`)).toMatch(/only one FROM/);
  });

  it('refuses a parser directive, such as a BuildKit frontend of its own choosing', () => {
    expect(environmentProblem(`# syntax=docker/dockerfile:1\n${godot}`)).toMatch(/parser directive/);
    expect(environmentProblem(`#escape=\`\n${godot}`)).toMatch(/parser directive/);
  });

  it('refuses a directive that BuildKit finds after a shebang line or on a later comment line', () => {
    expect(environmentProblem(`#!/bin/sh\n# syntax=attacker/frontend:latest\n${godot}`)).toMatch(/"#!" line/);
    expect(environmentProblem(`#!/bin/sh\n${godot}`)).toMatch(/"#!" line/);
    expect(environmentProblem(`# a comment\n# syntax=attacker/frontend\n${godot}`)).toMatch(/parser directive/);
    expect(environmentProblem(`\n\n# escape=\`\n${godot}`)).toMatch(/parser directive/);
  });

  it('judges a byte-order mark as BuildKit does', () => {
    expect(environmentProblem(`﻿# syntax=attacker/frontend\n${godot}`)).toMatch(/parser directive/);
    expect(environmentProblem(`﻿#!/bin/sh\n# syntax=attacker/frontend\n${godot}`)).toMatch(/"#!" line/);
    expect(environmentProblem(`﻿# just a comment\n${godot}`)).toBeNull();
  });

  it('accepts an ordinary leading comment and a blank first line', () => {
    expect(environmentProblem(`# Tools for the build\n${godot}`)).toBeNull();
    expect(environmentProblem(`\n${godot}`)).toBeNull();
    expect(environmentProblem(`${godot}\n# syntax=not a directive here`)).toBeNull();
  });

  it('refuses one that is too long', () => {
    expect(environmentProblem(`${godot}\n# ${'x'.repeat(MAX_ENVIRONMENT_LENGTH)}`)).toMatch(/at most 65536 characters/);
  });
});

describe("an Environment's image", () => {
  it('is tagged with the Project id and the hash of the Dockerfile', () => {
    expect(environmentImageTag(42, '0123456789ab')).toBe('devailoop-env-42:0123456789ab');
  });

  it('is recognised only in the exact form the runner gives it, for its own Project', () => {
    expect(isEnvironmentImageOf(42, 'devailoop-env-42:0123456789ab')).toBe(true);
    for (const image of [
      'devailoop-env-43:0123456789ab',
      'devailoop-env-4:0123456789ab',
      'devailoop-env-shop:0123456789ab',
      'devailoop-env-42:candidate-0123456789ab',
      'devailoop-env-42:0123456789AB',
      'devailoop-env-42',
      'evil.example/devailoop-env-42:0123456789ab',
      'devailoop-agent-base',
      'devailoop-env-42:0123456789ab:x',
    ]) {
      expect(isEnvironmentImageOf(42, image), image).toBe(false);
    }
  });
});
