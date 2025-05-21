/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import {onCall} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as crypto from "crypto";
import * as admin from "firebase-admin";
import axios from "axios";

// Initialize Firebase Admin
admin.initializeApp();

// Initialize Firestore with default database
const db = admin.firestore();
db.settings({
  databaseId: "default",
});

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// export const helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });


interface LastFMAuthResponse {
  session: {
    key: string;
    name: string;
  };
}

interface LastFMError {
  error: number;
  message: string;
}

interface LastFMTrack {
  name: string;
  artist: {
    "#text": string;
  };
  image: Array<{
    "#text": string;
  }>;
  date?: {
    "#text": string;
  };
}

interface LastFMRecentTracksResponse {
  recenttracks: {
    track: LastFMTrack[];
  };
}

interface LastFMUserResponse {
  user: {
    name: string;
    realname: string;
  };
}

export const lastfmAuth = onCall(async (request) => {
  const {username, password} = request.data;

  if (!username || !password) {
    throw new Error("Username and password are required");
  }

  try {
    const params = {
      method: "auth.getMobileSession",
      username,
      password,
      api_key: API_KEY,
    };

    const sig = signRequest(params);
    const body = new URLSearchParams();
    body.append("method", "auth.getMobileSession");
    body.append("username", username);
    body.append("password", password);
    body.append("api_key", API_KEY);
    body.append("api_sig", sig);
    body.append("format", "json");

    const response = await fetch("https://ws.audioscrobbler.com/2.0/", {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
      body: body.toString(),
    });

    const json = await response.json() as LastFMAuthResponse | LastFMError;

    if ("error" in json) {
      logger.error(" lastfm auth error", json);
      throw new Error(json.message || "Authentication failed");
    }

    if (!json.session?.key) {
      throw new Error("Invalid response from lastfm");
    }

    await db.collection("users").doc(json.session.key).set({
      username: json.session.name,
      lastLogin: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      sessionKey: json.session.key,
      username: json.session.name,
    };
  } catch (error) {
    logger.error("lastfm auth error", error);
    throw new Error("Authentication failed");
  }
});

export const lastfmGetRecentTracks = onCall(async (request) => {
  const {sessionKey, page = 1, limit = 20} = request.data;

  if (!sessionKey) {
    throw new Error("Session key is required");
  }

  try {
    const response = await fetch(
      `https://ws.audioscrobbler.com/2.0/?method=user.getRecentTracks&api_key=${API_KEY}&sk=${sessionKey}&format=json&limit=${limit}&page=${page}`,
    );
    const data = await response.json();

    if ("error" in data) {
      logger.error("lastfm failed to get recent tracks", data);
      throw new Error(data.message || "Failed to fetch recent tracks");
    }

    const tracksData = data as LastFMRecentTracksResponse;
    if (!tracksData.recenttracks?.track) {
      logger.error("Invalid response from lastfm", data);
      throw new Error("Invalid response from lastfm");
    }

    return tracksData;
  } catch (error) {
    logger.error("lastfm failed to get recent tracks", error);
    throw new Error("Failed to fetch recent tracks");
  }
});
/**
 * fetches user info from lastfm
 * @param {string} sessionKey - session key for auth
 * @return {Promise<LastFMUserResponse>}a
 */
async function fetchLastfmUserInfoDirect(sessionKey: string):
Promise<LastFMUserResponse> {
  const response = await fetch(
    `https://ws.audioscrobbler.com/2.0/?method=user.getInfo&api_key=${API_KEY}&sk=${sessionKey}&format=json`
  );
  return response.json();
}
export const lastfmGetUserInfo = onCall(async (request):
Promise<{ user: { realname?: string | null } }> => {
  const {sessionKey} = request.data;

  if (!sessionKey) {
    throw new Error("Session key is required");
  }
  try {
    const lastfmData = await fetchLastfmUserInfoDirect(sessionKey);
    const realname = lastfmData.user?.realname || null;

    await db.collection("users").doc(sessionKey).set({
      username: lastfmData.user?.name || null,
      realname,
      lastLogin: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      user: {
        realname: realname || undefined,
      },
    };
  } catch (error) {
    logger.error("lastfm getUserInfo error:", error);
    throw new Error("Failed to fetch user info");
  }
});

/**
 *
 * @param {Object.<string, string>} params
 * @return {string}
 */
function signRequest(params: {[key: string]: string}): string {
  const sorted = Object.keys(params).sort();
  let rawSig = "";

  for (const key of sorted) {
    rawSig += key + params[key];
  }

  rawSig += API_SECRET;
  return crypto.createHash("md5").update(rawSig).digest("hex");
}

interface EmotionData {
  trackId: string;
  trackTitle: string;
  artist: string;
  emotion: string;
  timestamp: number;
}

export const storeEmotion = onCall(async (request) => {
  const {sessionKey, trackId, trackTitle, artist, emotion} = request.data;

  if (!sessionKey || !trackId || !trackTitle || !artist || !emotion) {
    throw new Error("Missing the required fields");
  }

  try {
    const emotionData: EmotionData = {
      trackId,
      trackTitle,
      artist,
      emotion,
      timestamp: Date.now(),
    };

    // check if emotion already exists for track
    const existingEmotion = await db.collection("users")
      .doc(sessionKey)
      .collection("emotions")
      .where("trackId", "==", trackId)
      .limit(1)
      .get();

    if (!existingEmotion.empty) {
      const docId = existingEmotion.docs[0].id;
      await db.collection("users")
        .doc(sessionKey)
        .collection("emotions")
        .doc(docId)
        .update({...emotionData});
    } else {
      // crete new emotion
      await db.collection("users")
        .doc(sessionKey)
        .collection("emotions")
        .add(emotionData);
    }

    return {success: true};
  } catch (error) {
    logger.error("error storing the emotion", error);
    throw new Error("Failed to store emotion");
  }
});

export const getEmotions = onCall(async (request) => {
  const {sessionKey} = request.data;

  if (!sessionKey) {
    throw new Error("Session key is required");
  }

  try {
    // first check if the user's document exists
    const userDoc = await db.collection("users").doc(sessionKey).get();
    if (!userDoc.exists) {
      logger.info("User document not found creating new user document");
      // create the new user's document
      await db.collection("users").doc(sessionKey).set({
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLogin: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const emotionsSnapshot = await db.collection("users")
      .doc(sessionKey)
      .collection("emotions")
      .orderBy("timestamp", "desc")
      .get();

    const emotions = emotionsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return {emotions};
  } catch (error) {
    logger.error("Error in getEmotions:", error);
    throw new Error("Failed to fetch emotions");
  }
});

export const testFirestore = onCall(async (request) => {
  try {
    const snapshot = await db.collection("users").get();
    const userIds = snapshot.docs.map((doc) => doc.id);
    return {userIds};
  } catch (error: any) {
    return {error: error.message};
  }
});

export const lastfmSearchforTracks = onCall(async (request) => {
  const {query} = request.data;

  if (!query) {
    throw new Error("Query is required");
  }

  try {
    const response = await axios.get("https://ws.audioscrobbler.com/2.0/", {
      params: {
        method: "track.search",
        api_key: API_KEY,
        format: "json",
        track: query,
      },
    });
    const tracks = response.data?.results?.trackmatches?.track || [];
    for (const track of tracks) {
      try {
        const trackInfo = await axios.get("https://ws.audioscrobbler.com/2.0/", {
          params: {
            method: "track.getInfo",
            api_key: API_KEY,
            format: "json",
            artist: track.artist,
            track: track.name,
            autocorrect: 1,
          },
        });
        if (trackInfo.data?.track?.album?.image) {
          track.image = trackInfo.data.track.album.image;
        }
      } catch (error) {
        logger.error("Error fetching track info:", error);
      }
    }

    const data = response.data;
    if ("error" in data) {
      logger.error("lastfm search tracks error:", data);
      throw new Error(data.message || "Failed to search tracks");
    }

    if (!data.results?.trackmatches?.track) {
      logger.error("Invalid response from lastfm", data);
      throw new Error("Invalid response from lastfm");
    }

    return data;
  } catch (error) {
    logger.error("lastfm search tracks error:", error);
    throw new Error("Failed to search tracks");
  }
});
export const deleteEmotionHistory = onCall(async (request) => {
  const {sessionKey} = request.data;
  if (!sessionKey) {
    throw new Error("Missing required fields");
  }
  try {
    const emotionsSnapshot = await db.collection("users")
      .doc(sessionKey)
      .collection("emotions")
      .get();

    const batch = db.batch();
    emotionsSnapshot.forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    return {success: true};
  } catch (error) {
    logger.error("Error deleting emotion:", error);
    throw new Error("Failed to delete emotion from database");
  }
});

export const deleteEmotion = onCall(async (request) => {
  const {sessionKey, emotionId} = request.data;
  if (!sessionKey || !emotionId) {
    throw new Error("Missing required fields");
  }
  try {
    await db.collection("users")
      .doc(sessionKey)
      .collection("emotions")
      .doc(emotionId)
      .delete();
    return {success: true};
  } catch (error) {
    logger.error("Error deleting emotion:", error);
    throw new Error("Failed to delete emotion");
  }
});

export const deleteAccount = onCall(async (request) => {
  const {sessionKey} = request.data;
  if (!sessionKey) {
    throw new Error("Missing required fields");
  }
  try {
    await db.collection("users")
      .doc(sessionKey)
      .delete();
    return {success: true};
  } catch (error) {
    logger.error("Error deleting account:", error);
    throw new Error("Failed to delete account");
  }
});

export const firstLogin = onCall(async (request) => {
  const {sessionKey, uid} = request.data;
  try {
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    if (userDoc.exists && userDoc.data()?.userinfo?.realname) {
      return {success: true, message: "User info already exists"};
    }
    const lastfmData = await fetchLastfmUserInfoDirect(sessionKey);
    const realname = lastfmData.user?.realname || null;

    await userRef.set(
      {
        userinfo: {
          realname,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
      {merge: true}
    );
    return {success: true};
  } catch (err) {
    logger.error("Error in first login:", err);
    throw new Error("Failed to fetch real name");
  }
});

export const fetchRealname = onCall(async (request) => {
  const {sessionKey} = request.data;
  try {
    const userDoc = await db.collection("users").doc(sessionKey).get();
    if (userDoc.exists) {
      const realname = userDoc.data()?.userinfo?.realname || null;
      return {realname};
    }
    return {realname: null};
  } catch (error) {
    logger.error("Error fetching real name from database", error);
    throw new Error("Failed to fetch real name from dataase");
  }
});
