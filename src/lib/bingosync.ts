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
	const response = await ky
		.post(roomUrl, {
			/* eslint-disable @typescript-eslint/camelcase */
			json: {
				room: params.roomCode,
				nickname: params.playerName,
				password: params.passphrase,

				// We only support spectating at this time
				is_spectator: true,
			},
			/* eslint-enable @typescript-eslint/camelcase */
		})
		.json();
	return response.socket_key;
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

	private _fullUpdateInterval: NodeJS.Timer;

	private _websocket: WebSocket | null = null;

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
		this._setStatus("connecting");
		clearInterval(this._fullUpdateInterval);
		this._destroyWebsocket();

		let successfulSocketKey: string;
		const cachedSocketKey = loadCachedSocketKey(roomCode, playerName);
		if (cachedSocketKey) {
			try {
				// Try cached key
				successfulSocketKey = cachedSocketKey;
			} catch (_) {
				// Get and use new key
				successfulSocketKey = await getNewSocketKey({
					siteUrl,
					roomCode,
					passphrase,
					playerName,
				});
			}
		} else {
			// Get and use new key
			successfulSocketKey = await getNewSocketKey({
				siteUrl,
				roomCode,
				passphrase,
				playerName,
			});
		}

		saveSocketKey(roomCode, playerName, successfulSocketKey);

		// Save the room params so other methods can read them
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(this as any).roomParams = {
			siteUrl,
			socketUrl,
			roomCode,
			passphrase,
			playerName,
		};

		this._setStatus("connected");

		this._fullUpdateInterval = setInterval(() => {
			this._fullUpdate().catch(error => {
				debug("Failed to fullUpdate:", error);
			});
		}, this.fullUpdateIntervalTime);

		await this._fullUpdate();
		await this._createWebsocket(socketUrl, successfulSocketKey);
	}

	disconnect(): void {
		clearInterval(this._fullUpdateInterval);
		this._destroyWebsocket();
		this._setStatus("disconnected");
	}

	private _setStatus(newStatus: SocketStatus): void {
		(this as any).status = newStatus; // eslint-disable-line @typescript-eslint/no-explicit-any
		this.emit("status-changed", newStatus);
	}

	private async _fullUpdate(): Promise<void> {
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

	private async _createWebsocket(
		socketUrl: string,
		socketKey: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;

			debug("Opening socket...");
			this._setStatus("connecting");
			const broadcastUrl = new URL("/broadcast", socketUrl);
			this._websocket = new WebSocket(broadcastUrl.href);

			this._websocket.onopen = () => {
				debug("Socket opened.");
				if (this._websocket) {
					this._websocket.send(
						/* eslint-disable @typescript-eslint/camelcase */
						JSON.stringify({
							socket_key: socketKey,
						}),
						/* eslint-enable @typescript-eslint/camelcase */
					);
				}
			};

			this._websocket.onmessage = event => {
				let json;
				try {
					json = JSON.parse(event.data as string);
				} catch (_) {
					debug("Failed to parse message:", event.data);
				}

				if (json.type === "error") {
					clearInterval(this._fullUpdateInterval);
					this._destroyWebsocket();
					this._setStatus("error");
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
					this._setStatus("connected");
					settled = true;
				}

				if (json.type === "goal") {
					const index = parseInt(json.square.slot.slice(4), 10) - 1;
					this.boardState.cells[index] = json.square;
				}
			};

			this._websocket.onclose = event => {
				this._setStatus("disconnected");
				debug(
					`Socket closed (code: ${event.code}, reason: ${event.reason})`,
				);
				this._destroyWebsocket();
				this._createWebsocket(socketUrl, socketKey).catch(() => {
					// Intentionally discard errors raised here.
					// They will have already been logged in the onmessage handler.
				});
			};
		});
	}

	private _destroyWebsocket(): void {
		if (!this._websocket) {
			return;
		}

		try {
			this._websocket.onopen = () => {};
			this._websocket.onmessage = () => {};
			this._websocket.onclose = () => {};
			this._websocket.close();
		} catch (_) {
			// Intentionally discard error.
		}

		this._websocket = null;
	}
}
