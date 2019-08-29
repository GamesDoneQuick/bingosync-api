import * as fetchMock from "fetch-mock";
import { Server } from "mock-socket";
import * as deepEql from "fast-deep-equal";
import cuid = require("cuid");
import { expect } from "chai";

// Annoying hack which requires calling a private method of fetchMock
// to make it work with the way that ky caches its reference to `global.fetch`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(fetchMock as any)._mock();

let mockServers: Server[] = [];

export const setup = {
	joinRoom: setupRoomJoinMock,
};

export const actions = {
	deauthorizeAllSockets,
};

function setupRoomJoinMock({
	siteUrl = "https://bingosync.com",
	socketUrl = "ws://localhost:8080",
	roomCode = cuid(),
	playerName = cuid(),
	passphrase = cuid(),
	repeat = 1,
	rejectPassword = false,
	createSocketServer = true,
	createFullUpdateRoute = true,
} = {}): {
	siteUrl: string;
	socketUrl: string;
	socketKey: string;
	roomCode: string;
	playerName: string;
	passphrase: string;
	socketServer?: Server;
} {
	const roomOptions = {
		siteUrl,
		socketUrl,
		socketKey: cuid(),
		roomCode,
		playerName,
		passphrase,
	};

	const getSocketKeyUrl = `${siteUrl}/api/get-socket-key/${roomOptions.roomCode}`;

	fetchMock.post(
		(url, options) => {
			if (typeof options.body !== "string") {
				return false;
			}

			const urlMatches = url === `${siteUrl}/api/join-room`;
			const bodyMatches = deepEql(JSON.parse(options.body), {
				/* eslint-disable @typescript-eslint/camelcase */
				room: roomOptions.roomCode,
				nickname: roomOptions.playerName,
				password: roomOptions.passphrase,
				is_spectator: true,
				/* eslint-enable @typescript-eslint/camelcase */
			});
			return urlMatches && bodyMatches;
		},
		rejectPassword
			? {
					status: 400,
					body: {
						// Yes, this is actually what bingosync.com will reply with in this scenario.
						__all__: [
							{
								message: "Incorrect Password",
								code: "",
							},
						],
					},
			  }
			: {
					status: 302,
					headers: {
						// Yep, a success here results in a redirect to another endpoint.
						Location: getSocketKeyUrl,
					},
			  },
		{
			repeat,
		},
	);

	if (rejectPassword) {
		return roomOptions;
	}

	fetchMock.get(
		getSocketKeyUrl,
		{
			status: 200,
			body: {
				// eslint-disable-next-line @typescript-eslint/camelcase
				socket_key: roomOptions.socketKey,
			},
		},
		{
			repeat,
		},
	);

	if (createFullUpdateRoute) {
		fetchMock.get(`${siteUrl}/room/${roomOptions.roomCode}/board`, {
			status: 200,
			body: [],
		});
	}

	if (createSocketServer) {
		const socketServer = setupSocketJoinMock({
			socketUrl: roomOptions.socketUrl,
			socketKey: roomOptions.socketKey,
		});

		return {
			...roomOptions,
			socketServer,
		};
	}

	return roomOptions;
}

function setupSocketJoinMock({
	socketUrl,
	socketKey,
}: {
	socketUrl: string;
	socketKey: string;
}): Server {
	const mockServer = new Server(`${socketUrl}/broadcast`);

	let currentSocketKey = socketKey;
	mockServer.on("connection", socket => {
		socket.on("message", data => {
			if (typeof data !== "string") {
				return;
			}

			const parsedData = JSON.parse(data);
			if (parsedData.socket_key === currentSocketKey) {
				// This isn't what bingosync would actually send, but it's good enough for our test.
				socket.send(
					JSON.stringify({
						type: "made_up",
						message: "SUCCESS",
					}),
				);
			} else {
				socket.send(
					JSON.stringify({
						type: "error",
						error: "unable to authenticate, try refreshing",
					}),
				);
			}
		});
	});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(mockServer as any).setKey = (newKey: string): void => {
		currentSocketKey = newKey;
	};

	mockServers.push(mockServer);

	return mockServer;
}

function deauthorizeAllSockets(server: Server): void {
	server.clients().forEach(socket => {
		socket.send(
			JSON.stringify({
				type: "error",
				error: "unable to authenticate, try refreshing",
			}),
		);
	});
}

export function verify(): void {
	expect(fetchMock.done()).to.equal(true);
}

export function reset(): void {
	fetchMock.reset();
}

export function end(): void {
	reset();
	mockServers.forEach(server => {
		server.stop();
	});
	mockServers = [];
}
