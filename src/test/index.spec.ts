// Packages
import * as fetchMock from "./mocks"; // This must come first.
import { WebSocket as MockWebSocket } from "mock-socket";
import { use, expect } from "chai";
import * as chaiAsPromised from "chai-as-promised";

// Ours
import { Bingosync } from "../index";

use(chaiAsPromised);

let client: Bingosync;

beforeEach(() => {
	client = new Bingosync();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(client as any).WebSocketClass = MockWebSocket;
});

afterEach(() => {
	client.disconnect();
	fetchMock.reset();
});

it.only("joins the room and socket", async () => {
	const roomParams = fetchMock.setup.joinRoom();
	fetchMock.setup.joinSocket();
	await client.joinRoom(roomParams);
	fetchMock.done();
});

it("rejects when using the wrong password", async () => {
	const roomParams = fetchMock.setup.joinRoom({ rejectPassword: true });
	await expect(client.joinRoom(roomParams)).to.eventually.throw(
		"Incorrect Password",
	);
	fetchMock.done();
});

it("when reconnecting, uses existing socket key instead of rejoining the room", async () => {
	const roomParams = fetchMock.setup.joinRoom({
		// Enforce that the room join endpoint is only hit once.
		// This method actually defaults to `repeat: 1`, but it's good to be
		// explicit here.
		repeat: 1,
	});
	fetchMock.setup.joinSocket();
	await client.joinRoom(roomParams);
	client.disconnect();
	await client.joinRoom(roomParams);
	fetchMock.done();
});

it("rejoins the room if the socket key has expired", async done => {
	const roomParams = fetchMock.setup.joinRoom();
	const { server } = fetchMock.setup.joinSocket();
	await client.joinRoom(roomParams);

	let numDisconnects = 0;
	client.on("disconnect", () => {
		numDisconnects++;
	});
	client.on("connect", () => {
		expect(numDisconnects).to.equal(1);
		fetchMock.done();
		done();
	});
	fetchMock.actions.deauthorizeAllSockets(server);
});

it("emits an event when the board changes", async () => {
	const roomParams = fetchMock.setup.joinRoom();
	fetchMock.setup.joinSocket();
	await client.joinRoom(roomParams);
	fetchMock.done();
});

it("supports connecting to alternate deployments of bingosync", async () => {
	const siteUrl = "http://fake.example.com";
	const socketUrl = "ws://localhost:9999";
	const roomParams = fetchMock.setup.joinRoom({ siteUrl });
	fetchMock.setup.joinSocket({ socketUrl });
	await client.joinRoom({
		...roomParams,
		siteUrl,
		socketUrl,
	});
	fetchMock.done();
});
