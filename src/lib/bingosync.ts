// Packages
import ky from "ky-universal";
import * as WebSocket from "isomorphic-ws";

const request = RequestPromise.defaults({ jar: true }); // <= Automatically saves and re-uses cookies.
const boardRep = nodecg.Replicant<BingosyncBoard>("bingosync_board");
const socketRep = nodecg.Replicant<BingosyncSocket>("bingosync_socket");
let fullUpdateInterval: NodeJS.Timer;
let websocket: WebSocket | null = null;

// save socket keys to localstorage in a map that maps from roomCode to socketKey
// and always try the persisted key first
// need isomorphic localstorage

export interface RoomJoinParameters {
	roomCode: string;
	playerName: string;
	passphrase?: string;
	siteUrl?: string;
	socketUrl?: string;
	spectate?: true /* we only support joining as a spectator at this time */;
}

nodecg.listenFor("bingosync:joinRoom", async (data, callback) => {
	try {
		socketRep.value = {
			...socketRep.value,
			...data,
		};
		await joinRoom({
			siteUrl: data.siteUrl,
			socketUrl: data.socketUrl,
			roomCode: data.roomCode,
			passphrase: data.passphrase,
			playerName: data.playerName,
		});
		log.info(`Successfully joined room ${data.roomCode}.`);
		if (callback && !callback.handled) {
			callback();
		}
	} catch (error) {
		socketRep.value.status = "error";
		log.error(`Failed to join room ${data.roomCode}:`, error);
		if (callback && !callback.handled) {
			callback(error);
		}
	}
});

nodecg.listenFor("bingosync:leaveRoom", (_data, callback) => {
	try {
		clearInterval(fullUpdateInterval);
		destroyWebsocket();
		socketRep.value.status = "disconnected";
		if (callback && !callback.handled) {
			callback();
		}
	} catch (error) {
		log.error("Failed to leave room:", error);
		if (callback && !callback.handled) {
			callback(error);
		}
	}
});

nodecg.listenFor("bingosync:selectLine", (lineString, callback) => {
	try {
		boardRep.value.selectedLine = lineString;
		if (callback && !callback.handled) {
			callback();
		}
	} catch (error) {
		if (callback && !callback.handled) {
			callback(error);
		}
	}
});

nodecg.listenFor("bingosync:toggleLineFocus", (_data, callback) => {
	try {
		boardRep.value.lineFocused = !boardRep.value.lineFocused;
		if (callback && !callback.handled) {
			callback();
		}
	} catch (error) {
		if (callback && !callback.handled) {
			callback(error);
		}
	}
});

nodecg.listenFor("bingosync:toggleCard", (_data, callback) => {
	try {
		boardRep.value.cardHidden = !boardRep.value.cardHidden;
		if (callback && !callback.handled) {
			callback();
		}
	} catch (error) {
		if (callback && !callback.handled) {
			callback(error);
		}
	}
});

nodecg.listenFor("bingosync:toggleEmbiggen", (_data, callback) => {
	try {
		boardRep.value.embiggen = !boardRep.value.embiggen;
		if (callback && !callback.handled) {
			callback();
		}
	} catch (error) {
		if (callback && !callback.handled) {
			callback(error);
		}
	}
});

recover().catch(error => {
	log.error(
		`Failed to recover connection to room ${socketRep.value.roomCode}:`,
		error,
	);
});
async function recover(): Promise<void> {
	// Restore previous connection on startup.
	if (socketRep.value.roomCode && socketRep.value.passphrase) {
		log.info(`Recovering connection to room ${socketRep.value.roomCode}`);
		await joinRoom(socketRep.value);
		log.info(
			`Successfully recovered connection to room ${socketRep.value.roomCode}`,
		);
	}
}

async function joinRoom({
	siteUrl = "https://bingosync.com",
	socketUrl = "wss://sockets.bingosync.com",
	roomCode,
	passphrase,
	playerName = "NodeCG",
}: {
	siteUrl?: string;
	socketUrl?: string;
	roomCode: string;
	passphrase: string;
	playerName?: string;
}): Promise<void> {
	socketRep.value.status = "connecting";
	clearInterval(fullUpdateInterval);
	destroyWebsocket();

	log.info("Attempting to load room page.");
	const roomUrl = `${siteUrl}/room/${roomCode}`;
	let $ = await request({
		uri: roomUrl,
		transform(body, response) {
			if (!String(response.statusCode).startsWith("2")) {
				return body;
			}

			return cheerio.load(body);
		},
	});

	// If input[name="csrfmiddlewaretoken"] exists on the page, then we must be on the "Join Room" form.
	// Else, we must be in the actual game room.
	const csrfTokenInput = $('input[name="csrfmiddlewaretoken"]');
	if (csrfTokenInput) {
		log.info("Joining room...");

		// POST to join the room.
		await request({
			method: "POST",
			uri: roomUrl,
			form: {
				room_name: $('input[name="room_name"]').val(),
				encoded_room_uuid: $('input[name="encoded_room_uuid"]').val(),
				creator_name: $('input[name="creator_name"]').val(),
				game_name: $('input[name="game_name"]').val(),
				player_name: playerName,
				passphrase,
				csrfmiddlewaretoken: csrfTokenInput.val(),
			},
			headers: {
				Referer: roomUrl,
			},
			resolveWithFullResponse: true,
			simple: false,
		});

		log.info("Joined room.");
		log.info("Loading room page...");

		// Request the room page again, so that we can extract the socket token from it.
		$ = await request({
			uri: roomUrl,
			transform(body, response) {
				if (!String(response.statusCode).startsWith("2")) {
					return body;
				}

				return cheerio.load(body);
			},
		});
	}

	log.info("Loaded room page.");

	// Socket stuff
	const matches = $.html().match(SOCKET_KEY_REGEX);
	if (!matches) {
		log.error("Socket key not found on page.");
		return;
	}

	const socketKey = matches[1];
	if (!socketKey) {
		log.error("Socket key not found on page.");
		return;
	}

	const thisInterval = setInterval(() => {
		fullUpdate().catch(error => {
			log.error("Failed to fullUpdate:", error);
		});
	}, 15 * 1000);
	fullUpdateInterval = thisInterval;

	await fullUpdate();
	await createWebsocket(socketUrl, socketKey);

	async function fullUpdate(): Promise<void> {
		const newBoardState = await request({
			uri: `${roomUrl}/board`,
			json: true,
		});

		// Bail if the room changed while this request was in-flight.
		if (fullUpdateInterval !== thisInterval) {
			return;
		}

		// Bail if nothing has changed.
		if (equal(boardRep.value.cells, newBoardState)) {
			return;
		}

		boardRep.value.cells = newBoardState;
	}
}

async function createWebsocket(
	socketUrl: string,
	socketKey: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;

		log.info("Opening socket...");
		socketRep.value.status = "connecting";
		websocket = new WebSocket(`${socketUrl}/broadcast`);

		websocket.onopen = () => {
			log.info("Socket opened.");
			if (websocket) {
				websocket.send(JSON.stringify({ socket_key: socketKey }));
			}
		};

		websocket.onmessage = event => {
			let json;
			try {
				json = JSON.parse(event.data as string);
			} catch (_) {
				log.error("Failed to parse message:", event.data);
			}

			if (json.type === "error") {
				clearInterval(fullUpdateInterval);
				destroyWebsocket();
				socketRep.value.status = "error";
				log.error(
					"Socket protocol error:",
					json.error ? json.error : json,
				);
				if (!settled) {
					reject(
						new Error(json.error ? json.error : "unknown error"),
					);
					settled = true;
				}

				return;
			}

			if (!settled) {
				resolve();
				socketRep.value.status = "connected";
				settled = true;
			}

			if (json.type === "goal") {
				const index = parseInt(json.square.slot.slice(4), 10) - 1;
				boardRep.value.cells[index] = json.square;
			}
		};

		websocket.onclose = event => {
			socketRep.value.status = "disconnected";
			log.info(
				`Socket closed (code: ${event.code}, reason: ${event.reason})`,
			);
			destroyWebsocket();
			createWebsocket(socketUrl, socketKey).catch(() => {
				// Intentionally discard errors raised here.
				// They will have already been logged in the onmessage handler.
			});
		};
	});
}

function destroyWebsocket(): void {
	if (!websocket) {
		return;
	}

	try {
		websocket.onopen = () => {};
		websocket.onmessage = () => {};
		websocket.onclose = () => {};
		websocket.close();
	} catch (_) {
		// Intentionally discard error.
	}

	websocket = null;
}