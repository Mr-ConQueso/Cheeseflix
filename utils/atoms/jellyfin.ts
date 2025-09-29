import { type Api } from "@jellyfin/sdk";
import type { UserDto } from "@jellyfin/sdk/lib/generated-client/models";
import { atom } from "jotai";

export const apiAtom = atom<Api | null>(null);
export const userAtom = atom<UserDto | null>(null);
export const wsAtom = atom<WebSocket | null>(null);
