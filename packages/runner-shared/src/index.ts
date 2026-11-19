// What the runner takes from the rest of DevAILoop. The runner's source is published in a public
// repository (docs/ci-cd.md), so it builds on this package alone and never on @devailoop/core.
// @devailoop/core re-exports everything here.

export * from './environment';
export * from './log';

/** A Project Code is 2 to 10 capital letters or digits, starting with a letter. */
export const PROJECT_CODE_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
