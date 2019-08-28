import * as fetchMock from "fetch-mock";
import { Server } from "mock-socket";
import * as deepEql from "fast-deep-equal";

// Annoying hack which requires calling a private method of fetchMock
// to make it work with the way that ky caches its reference to `global.fetch`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(fetchMock as any)._mock();

import { RoomJoinParameters } from "../index";

const defaultValues = {
	roomId: "asdf1234",
	roomPassword: "4321fdsa",
	wrongPassword: "wrong",
	nickname: "qwer5678",
	socketKey: "socket_key_for_me",
	siteUrl: "https://bingosync.com",
	socketUrl: "ws://localhost:8080",
};

let mockServers: Server[] = [];

export const setup = {
	joinRoom: setupRoomJoinMock,
	joinSocket: setupSocketJoinMock,
};

export const actions = {
	deauthorizeAllSockets,
};

function setupRoomJoinMock({
	siteUrl = defaultValues.siteUrl,
	repeat = 1,
	rejectPassword = false,
} = {}): Pick<
	RoomJoinParameters,
	"siteUrl" | "roomCode" | "playerName" | "passphrase"
> {
	const roomOptions = {
		siteUrl,
		socketUrl: defaultValues.socketUrl,
		roomCode: defaultValues.roomId,
		playerName: defaultValues.nickname,
		passphrase: defaultValues.roomPassword,
	};

	const getSocketKeyUrl = `${siteUrl}/api/get-socket-key/${defaultValues.roomId}`;

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

	fetchMock.get(
		getSocketKeyUrl,
		{
			status: 200,
			body: {
				// eslint-disable-next-line @typescript-eslint/camelcase
				socket_key: defaultValues.socketKey,
			},
		},
		{
			repeat,
		},
	);

	fetchMock.get(`${siteUrl}/room/${roomOptions.roomCode}/board`, {
		status: 200,
		body: [],
	});

	return roomOptions;
}

function setupSocketJoinMock({ socketUrl = defaultValues.socketUrl } = {}): {
	socketUrl: string;
	socketKey: string;
	server: Server;
} {
	const socketJoinOptions = {
		socketUrl,
		socketKey: "socket_key_for_me",
	};
	console.log("mocking server at:", `${socketUrl}/broadcast`);
	const mockServer = new Server(`${socketUrl}/broadcast`);

	mockServer.on("connection", socket => {
		socket.on("message", data => {
			if (typeof data !== "string") {
				return;
			}

			const parsedData = JSON.parse(data);
			if (parsedData.socket_key === socketJoinOptions.socketKey) {
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

	mockServers.push(mockServer);

	return {
		...socketJoinOptions,
		server: mockServer,
	};
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

export function done(): void {
	fetchMock.done();
}

export function reset(): void {
	fetchMock.reset();
	mockServers.forEach(server => {
		server.stop();
	});
	mockServers = [];
}
