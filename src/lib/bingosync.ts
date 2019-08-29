// Packages
import ky from "ky-universal";
import * as WebSocket from "isomorphic-ws";
import dbg from "debug";
import { EventEmitter } from "eventemitter3";
import * as equal from "fast-deep-equal";

// Ours
import localStorage from "./isomorphic-localstorage";

const debug = dbg("bingosync-api");

interface Events {
	"status-changed": [string];
	"board-changed": [BoardState];
}

export type CellColor =
	| "orange"
	| "red"
	| "blue"
	| "green"
	| "purple"
	| "navy"
	| "teal"
	| "brown"
	| "pink"
	| "yellow";

export interface RoomJoinParameters {
	roomCode: string;
	playerName: string;
	passphrase?: string;
	siteUrl?: string;
	socketUrl?: string;
}

export interface BoardCell {
	slot: string;
	colors: CellColor[];
	name: string;
}

export interface BoardState {
	cells: BoardCell[];
}

type RawBoardState = Array<{
	colors: string;
	slot: string;
	name: string;
}>;

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
export class Bingosync extends EventEmitter<Events> {
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

	/**
	 * How many times to attempt to authenticate with the socket
	 * before giving up and emitting an "error" event.
	 */
	maxSocketAuthAttempts = 3;

	/**
	 * A reference to the setInterval for performing full updates,
	 * which are used to fill in any gaps caused by missed socket packets.
	 */
	private _fullUpdateInterval: NodeJS.Timer;

	/**
	 * A reference to the websocket client instance currently being used, if any.
	 */
	private _websocket: WebSocket | null = null;

	/**
	 * How many socket auth attempts we have tried in the current iteration.
	 */
	private _numSocketAuthAttempts = 0;

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

		// It might seem spooky that we're not validating the cached socket key here.
		// It's okay though, because the _createWebSocket method creates an error handler
		// which will detect an expired key, and automatically request a fresh one.
		// So, we don't need to worry too much about checking if our saved key is expired here.
		const socketKey =
			this._loadCachedSocketKey(playerName, roomCode) ||
			(await getNewSocketKey({
				siteUrl,
				roomCode,
				passphrase,
				playerName,
			}));

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
		await this._createWebsocket(socketUrl, socketKey);
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

		const rawBoardState = await ky.get(boardUrl).json<RawBoardState>();

		// Bail if the room changed while this request was in-flight.
		if (requestedRoomCode !== this.roomParams.roomCode) {
			return;
		}

		// Make the raw data a bit more pleasant to work with.
		const newBoardState = this._processRawBoardState(rawBoardState);

		// Bail if nothing has changed.
		if (equal(this.boardState, newBoardState)) {
			return;
		}

		this.boardState = newBoardState;
		this.emit("board-changed", this.boardState);
	}

	private _processRawBoardState(rawBoardState: RawBoardState): BoardState {
		return {
			cells: rawBoardState.map(rawCell => {
				return {
					colors: rawCell.colors.split(" ").filter(color => {
						return color.toLowerCase() !== "blank";
					}) as CellColor[],
					slot: rawCell.slot,
					name: rawCell.name,
				};
			}),
		};
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

			this._websocket.onmessage = async event => {
				let json;
				try {
					json = JSON.parse(event.data as string);
				} catch (_) {
					debug("Failed to parse message:", event.data);
					return;
				}

				if (json.type === "error") {
					// This error can happen when the socket key expires,
					// which can happen when bingosync.com is redeployed or restarted.
					// In these cases, we often just need to request a new socket key and try again.
					if (
						json.error ===
							"unable to authenticate, try refreshing" &&
						this._numSocketAuthAttempts < this.maxSocketAuthAttempts
					) {
						if (!this._websocket) {
							reject(
								new Error(
									"The websocket disappeared when it shouldn't have",
								),
							);
							return;
						}

						this._numSocketAuthAttempts++;
						this._websocket.send(
							/* eslint-disable @typescript-eslint/camelcase */
							JSON.stringify({
								socket_key: await getNewSocketKey(
									this.roomParams,
								),
							}),
							/* eslint-enable @typescript-eslint/camelcase */
						);
						return;
					}

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
					// If we're here, then we know this socket key is valid, and we can save it for later.
					this._saveSocketKey(
						socketKey,
						this.roomParams.playerName,
						this.roomParams.roomCode,
					);
					this._setStatus("connected");
					settled = true;
					resolve();
				}

				this._numSocketAuthAttempts = 0;

				if (json.type === "goal") {
					const index = parseInt(json.square.slot.slice(4), 10) - 1;
					this.boardState.cells[index] = json.square;
					this.emit("board-changed", this.boardState);
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
