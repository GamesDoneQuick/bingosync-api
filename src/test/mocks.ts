import fetchMock from "fetch-mock";
import { Server } from "mock-socket";
import deepEql from "fast-deep-equal";
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
		roomCode: defaultValues.roomId,
		playerName: defaultValues.nickname,
		passphrase: defaultValues.roomPassword,
	};

	fetchMock.post(
		(url, options) => {
			return (
				url === `${siteUrl}/api/join-room` &&
				deepEql(options.body, roomOptions)
			);
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
					status: 301,
					body: {
						// Yep, a success here results in a redirect to another endpoint.
						Location: `${siteUrl}/api/get-socket-key/${defaultValues.roomId}`,
					},
			  },
		{
			repeat,
		},
	);

	fetchMock.get(
		`/api/get-socket-key/${defaultValues.roomId}`,
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
	const mockServer = new Server(`${socketUrl}/broadcast`);

	mockServer.on("connection", socket => {
		socket.on("message", data => {
			if (typeof data !== "string") {
				return;
			}

			const parsedData = JSON.parse(data);
			if (parsedData.socketKey === socketJoinOptions.socketKey) {
				// This isn't what bingosync would actually send, but it's good enough for our test.
				socket.send("SUCCESS");
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
}
