// Packages
import ky from "ky-universal";
import * as WebSocket from "isomorphic-ws";
import dbg from "debug";
import EventEmitter from "eventemitter3";
import equal from "fast-deep-equal";

// Ours
import localStorage from "./isomorphic-localstorage";

const debug = dbg("bingosync-api");

export interface RoomJoinParameters {
	roomCode: string;
	playerName: string;
	passphrase?: string;
	siteUrl?: string;
	socketUrl?: string;
}

export interface BoardCell {
	slot: string;
	colors: string;
	name: string;
}

export interface BoardState {
	cells: BoardCell[];
}

function computeLocalStorageKey(roomCode: string, playerName: string): string {
	return `bingosync-api:socket-key:${playerName}:${roomCode}`;
}

function loadCachedSocketKey(
	roomCode: string,
	playerName: string,
): string | null {
	return localStorage.getItem(computeLocalStorageKey(roomCode, playerName));
}

function saveSocketKey(
	roomCode: string,
	playerName: string,
	socketKey: string,
): void {
	return localStorage.setItem(
		computeLocalStorageKey(roomCode, playerName),
		socketKey,
	);
}

async function getNewSocketKey(
	params: Pick<
		RoomJoinParameters,
		"siteUrl" | "passphrase" | "playerName" | "roomCode"
	>,
): Promise<string> {
	const roomUrl = new URL("/api/join-room", params.siteUrl);
	const { socket_key } = await ky
		.post(roomUrl, {
			json: {
				room: params.roomCode,
				nickname: params.playerName,
				password: params.passphrase,

				// we only support spectating at this time
				is_spectator: true,
			},
		})
		.json();
	return socket_key;
}

type SocketStatus = "connecting" | "connected" | "disconnected" | "error";

export class Bingosync extends EventEmitter {
	/**
	 * The current status of the socket connection to the target Bingosync room.
	 */
	readonly status: SocketStatus = "disconnected";

	/**
	 * The details of the current room connection.
	 */
	readonly roomParams: RoomJoinParameters;

	/**
	 * The state of the bingo board.
	 */
	boardState: BoardState;

	/**
	 * How frequently to do a full update of the board state from Bingosync's REST API.
	 * These are done just to be extra paranoid and ensure that we don't miss things.
	 */
	fullUpdateIntervalTime = 15 * 1000;

	private fullUpdateInterval: NodeJS.Timer;

	private websocket: WebSocket | null = null;

	/**
	 * Joins a Bingosync room and subscribes to state changes from it.
	 */
	async joinRoom({
		siteUrl = "https://bingosync.com",
		socketUrl = "wss://sockets.bingosync.com",
		roomCode,
		passphrase,
		playerName,
	}: RoomJoinParameters): Promise<void> {
		this.setStatus("connecting");
		clearInterval(this.fullUpdateInterval);
		this.destroyWebsocket();

		let successfulSocketKey: string;
		const cachedSocketKey = loadCachedSocketKey(roomCode, playerName);
		if (cachedSocketKey) {
			try {
				// try cached key
				successfulSocketKey = cachedSocketKey;
			} catch (error) {
				// get and use new key
				successfulSocketKey = await getNewSocketKey({
					siteUrl,
					roomCode,
					passphrase,
					playerName,
				});
			}
		} else {
			// get and use new key
			successfulSocketKey = await getNewSocketKey({
				siteUrl,
				roomCode,
				passphrase,
				playerName,
			});
		}

		saveSocketKey(roomCode, playerName, successfulSocketKey);

		// save the room params so other methods can read them
		(this as any).roomParams = {
			siteUrl,
			socketUrl,
			roomCode,
			passphrase,
			playerName,
		};

		this.setStatus("connected");

		this.fullUpdateInterval = setInterval(() => {
			this.fullUpdate().catch(error => {
				debug("Failed to fullUpdate:", error);
			});
		}, this.fullUpdateIntervalTime);

		await this.fullUpdate();
		await this.createWebsocket(socketUrl, successfulSocketKey);
	}

	disconnect(): void {
		clearInterval(this.fullUpdateInterval);
		this.destroyWebsocket();
		this.setStatus("disconnected");
	}

	private setStatus(newStatus: SocketStatus): void {
		(this as any).status = newStatus;
		this.emit("status-changed", newStatus);
	}

	async fullUpdate(): Promise<void> {
		const requestedRoomCode = this.roomParams.roomCode;
		const boardUrl = new URL(
			`/room/${requestedRoomCode}/board`,
			this.roomParams.siteUrl,
		);

		const newBoardState = {
			cells: await ky.get(boardUrl).json(),
		};

		// Bail if the room changed while this request was in-flight.
		if (requestedRoomCode !== this.roomParams.roomCode) {
			return;
		}

		// Bail if nothing has changed.
		if (equal(this.boardState, newBoardState)) {
			return;
		}

		this.boardState = newBoardState;
	}

	private async createWebsocket(
		socketUrl: string,
		socketKey: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;

			debug("Opening socket...");
			this.setStatus("connecting");
			const broadcastUrl = new URL("/broadcast", socketUrl);
			this.websocket = new WebSocket(broadcastUrl.href);

			this.websocket.onopen = () => {
				debug("Socket opened.");
				if (this.websocket) {
					this.websocket.send(
						JSON.stringify({ socket_key: socketKey }),
					);
				}
			};

			this.websocket.onmessage = event => {
				let json;
				try {
					json = JSON.parse(event.data as string);
				} catch (_) {
					debug("Failed to parse message:", event.data);
				}

				if (json.type === "error") {
					clearInterval(this.fullUpdateInterval);
					this.destroyWebsocket();
					this.setStatus("error");
					debug(
						"Socket protocol error:",
						json.error ? json.error : json,
					);
					if (!settled) {
						reject(
							new Error(
								json.error ? json.error : "unknown error",
							),
						);
						settled = true;
					}

					return;
				}

				if (!settled) {
					resolve();
					this.setStatus("connected");
					settled = true;
				}

				if (json.type === "goal") {
					const index = parseInt(json.square.slot.slice(4), 10) - 1;
					this.boardState.cells[index] = json.square;
				}
			};

			this.websocket.onclose = event => {
				this.setStatus("disconnected");
				debug(
					`Socket closed (code: ${event.code}, reason: ${event.reason})`,
				);
				this.destroyWebsocket();
				this.createWebsocket(socketUrl, socketKey).catch(() => {
					// Intentionally discard errors raised here.
					// They will have already been logged in the onmessage handler.
				});
			};
		});
	}

	private destroyWebsocket(): void {
		if (!this.websocket) {
			return;
		}

		try {
			this.websocket.onopen = () => {};
			this.websocket.onmessage = () => {};
			this.websocket.onclose = () => {};
			this.websocket.close();
		} catch (_) {
			// Intentionally discard error.
		}

		this.websocket = null;
	}
}
