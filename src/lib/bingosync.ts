// Packages
import ky from "ky-universal";
import * as WebSocket from "isomorphic-ws";
import dbg from "debug";
import { EventEmitter } from "eventemitter3";
import * as equal from "fast-deep-equal";

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

async function getNewSocketKey(
	params: Pick<
		RoomJoinParameters,
		"siteUrl" | "passphrase" | "playerName" | "roomCode"
	>,
): Promise<string> {
	const roomUrl = new URL("/api/join-room", params.siteUrl);
	/* eslint-disable @typescript-eslint/camelcase */
	const response = await ky
		.post(roomUrl, {
			json: {
				room: params.roomCode,
				nickname: params.playerName,
				password: params.passphrase,

				// We only support spectating at this time
				is_spectator: true,
			},
			hooks: {
				afterResponse: [
					// Ky throws an error when a POST gets a redirect response,
					// but that's what bingosync actually does.
					// So, we have to use a response hook to work around this and prevent
					// ky from throwing an exception.
					// eslint-disable-next-line @typescript-eslint/promise-function-async
					response => {
						const location = response.headers.get("Location");
						if (!location) {
							return response;
						}

						return ky.get(location);
					},
				],
			},
		})
		.json<{ socket_key: string }>();
	/* eslint-enable @typescript-eslint/camelcase */
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

	/**
	 * The constructor to use when creating a WebSocket.
	 * We have to change this in tests, but it shouldn't
	 * need to be changed in prod.
	 */
	WebSocketClass = WebSocket;

	/**
	 * A string to prepend to all localstorage keys.
	 * Shouldn't be necessary to change this for prod,
	 * but we have to change it for testing.
	 */
	localStoragePrefix = "bingosync-api";

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
		const cachedSocketKey = this._loadCachedSocketKey(playerName, roomCode);
		if (cachedSocketKey) {
			try {
				// Try cached key
				successfulSocketKey = cachedSocketKey;
				// TODO: this isn't trying, it's just using it
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

		this._saveSocketKey(successfulSocketKey, playerName, roomCode);

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
			cells: await ky.get(boardUrl).json<BoardCell[]>(),
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
			this._websocket = new this.WebSocketClass(broadcastUrl.href);

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

	private _computeLocalStorageKey(
		playerName: string,
		roomCode: string,
	): string {
		return `${this.localStoragePrefix}:socket-key:${playerName}:${roomCode}`;
	}

	private _loadCachedSocketKey(
		playerName: string,
		roomCode: string,
	): string | null {
		return localStorage.getItem(
			this._computeLocalStorageKey(playerName, roomCode),
		);
	}

	private _saveSocketKey(
		socketKey: string,
		playerName: string,
		roomCode: string,
	): void {
		return localStorage.setItem(
			this._computeLocalStorageKey(playerName, roomCode),
			socketKey,
		);
	}
}
