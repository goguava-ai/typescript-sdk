# Guava Typescript SDK
[![NPM Version](https://img.shields.io/npm/v/%40guava-ai%2Fguava-sdk)](https://www.npmjs.com/package/@guava-ai/guava-sdk)

This library allows you to build Guava voice agents using TypeScript or Javascript. Currently only NodeJS is officially supported as a runtime.

## Documentation

Full documentation for the TypeScript SDK can be found at [https://goguava.ai/docs/](https://goguava.ai/docs/). SDK examples can be found under [./examples/](https://github.com/goguava-ai/typescript-sdk/tree/main/examples).

## Try an Example

Export two environment variables. You should have received these in your beta invite email.
```bash
$ export GUAVA_API_KEY="..." # Your API key for authentication.
$ export GUAVA_AGENT_NUMBER="..." # A phone number for your agent to use.
```

Run an outbound phone call example using `npx`. Replace the phone number with your own and your agent will call you.
```bash
$ npx @guava-ai/guava-sdk@latest scheduling-outbound +15556667777 # Your agent will call this number.
```

## Installation

Install the SDK using your preferred package manager.

```bash
$ npm install @guava-ai/guava-sdk
$ yarn add @guava-ai/guava-sdk
$ pnpm add @guava-ai/guava-sdk
```

The SDK can be used with Javascript, but TypeScript is highly recommended.