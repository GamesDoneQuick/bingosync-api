import { Bingosync } from "../index";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import * as fetchMock from "./mocks";

chai.use(chaiAsPromised);

let client: Bingosync;

beforeEach(() => {
	client = new Bingosync();
});

afterEach(() => {
	fetchMock.reset();
});

test("joins the room and socket", async () => {
	const roomParams = fetchMock.setup.joinRoom();
	fetchMock.setup.joinSocket();
	await client.joinRoom(roomParams);
	fetchMock.done();
});

test("rejects when using the wrong password", async () => {
	const roomParams = fetchMock.setup.joinRoom({ rejectPassword: true });
	await expect(client.joinRoom(roomParams)).to.eventually.throw(
		"Incorrect Password",
	);
	fetchMock.done();
});

test("when reconnecting, uses existing socket key instead of rejoining the room", async () => {
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

test("rejoins the room if the socket key has expired", async done => {
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

test("emits an event when the board changes", async () => {
	const roomParams = fetchMock.setup.joinRoom();
	fetchMock.setup.joinSocket();
	await client.joinRoom(roomParams);
	fetchMock.done();
});

test("supports connecting to alternate deployments of bingosync", async () => {
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
