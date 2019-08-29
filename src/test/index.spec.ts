// Packages
import * as mocks from "./mocks"; // This must come first.
import { WebSocket as MockWebSocket } from "mock-socket";
import { use, expect } from "chai";
import * as chaiAsPromised from "chai-as-promised";
import * as cuid from "cuid";

// Ours
import { Bingosync } from "../index";

use(chaiAsPromised);

let client: Bingosync;

beforeEach(() => {
	client = new Bingosync();
	client.localStoragePrefix = cuid();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(client as any).WebSocketClass = MockWebSocket;
});

afterEach(() => {
	client.disconnect();
	mocks.end();
});

it("joins the room and socket", async () => {
	const roomParams = mocks.setup.joinRoom();
	await client.joinRoom(roomParams);
	mocks.verify();
});

it("rejects when using the wrong password", async () => {
	const roomParams = mocks.setup.joinRoom({ rejectPassword: true });
	await expect(client.joinRoom(roomParams)).to.eventually.be.rejectedWith(
		"Bad Request",
	);
	mocks.verify();
});

it("when reconnecting, uses existing socket key instead of rejoining the room", async () => {
	const roomParams = mocks.setup.joinRoom({
		// Enforce that the room join endpoint is only hit once.
		// This method actually defaults to `repeat: 1`, but it's good to be
		// explicit here.
		repeat: 1,
	});
	await client.joinRoom(roomParams);
	client.disconnect();
	await client.joinRoom(roomParams);
	mocks.verify();
});

it("gets a new socket key when the saved one has expired", async () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(client as any)._loadCachedSocketKey = () => "INVALID";
	const roomParams = mocks.setup.joinRoom();
	await client.joinRoom(roomParams);
	mocks.verify();
});

it("rejoins the room if the socket key expires after an already successful connection has been established", async () => {
	const roomParams = mocks.setup.joinRoom();
	await client.joinRoom(roomParams);

	if (!roomParams.socketServer) {
		throw new Error("should have been a socket server here");
	}

	// Yes, we set up a new mock here, for a new socket_key.
	// But, we re-use all the other parameters.
	mocks.verify();
	mocks.reset();
	const { socketKey: newSocketKey } = mocks.setup.joinRoom({
		roomCode: roomParams.roomCode,
		playerName: roomParams.playerName,
		passphrase: roomParams.passphrase,
		createSocketServer: false,
		createFullUpdateRoute: false,
	});
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(roomParams.socketServer as any).setKey(newSocketKey);

	// Tell the client that its key is invalid,
	// which should make it request a new one.
	mocks.actions.deauthorizeAllSockets(roomParams.socketServer);

	// Sleep,
	await new Promise(resolve => {
		setTimeout(() => {
			resolve();
		}, 250);
	});

	// If the status is still "connected" here,
	// then we know it requested a new key and reauthed.
	// Also, we can verify our mocks to ensure that the new key was actually requested.
	expect(client.status).to.equal("connected");
	mocks.verify();
});

it("emits an event when the board changes", async () => {
	const roomParams = mocks.setup.joinRoom();
	await client.joinRoom(roomParams);
	mocks.verify();
});

it("supports connecting to alternate deployments of bingosync", async () => {
	const siteUrl = "http://fake.example.com";
	const socketUrl = "ws://localhost:9999";
	const roomParams = mocks.setup.joinRoom({ siteUrl, socketUrl });
	await client.joinRoom({
		...roomParams,
		siteUrl,
		socketUrl,
	});
	mocks.verify();
});
