# bingosync-api [![Build Status](https://dev.azure.com/gamesdonequick/bingosync-api/_apis/build/status/GamesDoneQuick.bingosync-api?branchName=master)](https://dev.azure.com/gamesdonequick/bingosync-api/_build/latest?definitionId=8&branchName=master)

> Programmatically interact with bingosync.com in realtime.

## Motivation

Bingosync is a great tool for speedrunners looking to play just about any kind of bingo they can imagine. And, since it is backed by a realtime websocket, it's a great source of data for other applications to consume. However, its API isn't the easiest, and creating a reliable websocket connection that can recover from unforeseen issues is challenging. So, we created this package to present a simplified and robust API for interacting with Bingosync deployments.

## Installation

```
npm install --save @gamesdonequick/bingosync-api
```

## Usage

```ts
import { Bingosync } from "@gamesdonequick/bingosync-api";
const bingosync = new Bingosync();

// Set up the event listener which will receive the board state updates.
bingosync.on("board-changed", boardState => {
	// boardState is an object with one key, called `cells`.
	// `cells` are objects structured like this:
	// interface BoardCell {
	// 	slot: string;
	// 	colors: CellColor[];
	// 	name: string;
	// }
	// So, to log every property of every cell, you could do the following:
	boardState.cells.forEach(cell => {
		console.log(cell.slot); // Examples: "slot1", "slot2", ..., "slot25", etc.
		console.log(cell.colors); // Examples: [] when a cell is blank, ["blue"], ["blue", "green"], etc.
		console.log(cell.name); // Whatever the displayed name of that cell is.
	});
});

// Set up an error handler to be informed of runtime issues.
// If you don't attach this handler, errors will be silently discarded.
bingosync.on("error", error => {
	console.error("something went wrong:", error);
});

// Connect to the room.
bingosync
	.joinRoom({
		roomCode: "c72KEvf1CsRZSjze1kg6HQ",
		passphrase: "your_cool_password",
		playerName: "Node.js",
	})
	.then(() => {
		console.log("successfully connected to bingosync");
	})
	.catch(error => {
		console.error("oh no something went wrong:", error);
	});
```

### Connecting to alternate deployments of Bingosync

Bingosync is open source, and you can run your own deployment of it! Here's how you'd use this library to connect to that:

```ts
bingosync
	.joinRoom({
		siteUrl: "http://example.com",
		socketUrl: "ws://example.com:8080",
		roomCode: "c72KEvf1CsRZSjze1kg6HQ",
		passphrase: "your_cool_password",
		playerName: "Node.js",
	})
	.then(() => {
		console.log(
			"successfully connected to our cool private deployment of bingosync on",
		);
	})
	.catch(error => {
		console.error("oh no something went wrong again:", error);
	});
```

## Limitations

Currently only supports joining as a spectator, and is therefore read-only. It is not possible to make changes to the board with this package yet, but this could be added if enough people need it.
