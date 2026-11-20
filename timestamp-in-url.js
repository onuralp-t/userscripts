// ==UserScript==
// @name         Video Timestamp URL Updater (YouTube & Twitch)
// @namespace    https://violentmonkey.github.io/
// @version      1.0.0
// @description  Updates YouTube watch and Twitch VOD URLs and browsing history entries with ?t= timestamps on pause, play, seek, tab switch, and page freeze.
// @match        https://www.youtube.com/*
// @match        https://www.twitch.tv/*
// @noframes
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // --- Layer 1: Assertions & Site Invariants ---

    function assert(condition, message) {
        if (!condition) {
            throw new Error('[Video Timestamp Updater] ' + message);
        }
    }

    function detectSupportedSite(locationObject) {
        assert(locationObject && typeof locationObject.hostname === 'string', 'window.location is required');
        assert(locationObject.protocol === 'https:', 'Expected https protocol, got: ' + locationObject.protocol);

        if (locationObject.hostname === 'www.youtube.com') {
            return 'youtube';
        }

        if (locationObject.hostname === 'www.twitch.tv') {
            return 'twitch';
        }

        assert(false, 'Unsupported hostname: ' + locationObject.hostname);
    }

    assert(typeof window.history.replaceState === 'function', 'history.replaceState is required');
    const activeSite = detectSupportedSite(window.location);

    // --- Layer 2: Pure URL & Timestamp Formatting ---

    function readTwitchVodIdFromUrl(href) {
        assert(typeof href === 'string' && href.length > 0, 'href must be a non-empty string');

        const parsedUrl = new URL(href);
        const standardVodMatch = /^\/videos\/(\d+)\/?$/.exec(parsedUrl.pathname);
        if (standardVodMatch) {
            return standardVodMatch[1];
        }

        const legacyVodMatch = /^\/[^/]+\/v(?:ideo)?\/(\d+)\/?$/.exec(parsedUrl.pathname);
        if (legacyVodMatch) {
            return legacyVodMatch[1];
        }

        return null;
    }

    function formatTwitchTimestamp(totalSeconds) {
        assert(Number.isInteger(totalSeconds) && totalSeconds >= 0, 'totalSeconds must be a non-negative integer');

        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        return (
            String(hours).padStart(2, '0') + 'h' +
            String(minutes).padStart(2, '0') + 'm' +
            String(seconds).padStart(2, '0') + 's'
        );
    }

    function buildTimestampedUrl(site, currentHref, timestampSeconds) {
        assert(typeof currentHref === 'string' && currentHref.length > 0, 'currentHref must be a non-empty string');
        assert(Number.isInteger(timestampSeconds) && timestampSeconds >= 0, 'timestampSeconds must be a non-negative integer');

        const nextUrl = new URL(currentHref);

        if (site === 'youtube') {
            assert(nextUrl.pathname === '/watch', 'Expected YouTube /watch URL');
            nextUrl.searchParams.set('t', String(timestampSeconds));
            return nextUrl.href;
        }

        if (site === 'twitch') {
            assert(readTwitchVodIdFromUrl(currentHref) !== null, 'Expected a Twitch VOD URL');
            nextUrl.searchParams.set('t', formatTwitchTimestamp(timestampSeconds));
            return nextUrl.href;
        }

        assert(false, 'Unknown site: ' + String(site));
    }

    // --- Layer 3: Player & Media State Inspection ---

    const TWITCH_PLAYER_SELECTOR = '.persistent-player, [data-a-target="video-player"], .video-player__container';
    const TWITCH_AD_SELECTOR = '[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"]';

    function readValidatedVideoTimestamp(videoElement) {
        if (!(videoElement instanceof HTMLVideoElement)) {
            return null;
        }

        if (videoElement.readyState < HTMLMediaElement.HAVE_METADATA) {
            return null;
        }

        if (!Number.isFinite(videoElement.currentTime) || videoElement.currentTime < 0) {
            return null;
        }

        const timestampSeconds = Math.floor(videoElement.currentTime);
        if (timestampSeconds === 0 && videoElement.played.length === 0) {
            return null;
        }

        return timestampSeconds;
    }

    function readYoutubeWatchState() {
        const currentUrl = new URL(window.location.href);
        if (currentUrl.pathname !== '/watch') {
            return null;
        }

        const urlVideoId = currentUrl.searchParams.get('v');
        if (!urlVideoId) {
            return null;
        }

        const playerElement = document.getElementById('movie_player');
        if (!(playerElement instanceof HTMLElement)) {
            return null;
        }

        const isShowingAd =
            playerElement.classList.contains('ad-showing') ||
            playerElement.classList.contains('ad-interrupting');
        if (isShowingAd) {
            return null;
        }

        if (typeof playerElement.getVideoData === 'function') {
            const videoData = playerElement.getVideoData();
            if (!videoData || videoData.video_id !== urlVideoId) {
                return null;
            }
        }

        const videoElement = playerElement.querySelector('video.html5-main-video');
        const timestampSeconds = readValidatedVideoTimestamp(videoElement);
        if (timestampSeconds === null) {
            return null;
        }

        return {
            mediaId: urlVideoId,
            videoElement: videoElement,
            timestampSeconds: timestampSeconds,
        };
    }

    function isTwitchPlayerShowingAd(playerElement) {
        assert(playerElement instanceof HTMLElement, 'playerElement must be an HTMLElement');
        return playerElement.querySelector(TWITCH_AD_SELECTOR) !== null;
    }

    function readTwitchVodState() {
        const vodId = readTwitchVodIdFromUrl(window.location.href);
        if (!vodId) {
            return null;
        }

        const playerElement = document.querySelector(TWITCH_PLAYER_SELECTOR);
        if (!(playerElement instanceof HTMLElement)) {
            return null;
        }

        if (isTwitchPlayerShowingAd(playerElement)) {
            return null;
        }

        const videoElement = playerElement.querySelector('video');
        const timestampSeconds = readValidatedVideoTimestamp(videoElement);
        if (timestampSeconds === null) {
            return null;
        }

        return {
            mediaId: vodId,
            videoElement: videoElement,
            timestampSeconds: timestampSeconds,
        };
    }

    // --- Layer 4: History Mutation ---

    function commitUrlToHistory(nextHref) {
        assert(typeof nextHref === 'string' && nextHref.length > 0, 'nextHref must be a non-empty string');

        const parsedNext = new URL(nextHref);
        assert(parsedNext.origin === window.location.origin, 'Refusing cross-origin history.replaceState');

        if (nextHref === window.location.href) {
            return;
        }

        window.history.replaceState(window.history.state, '', nextHref);
    }

    // --- Layer 5: Consolidated Control Flow & Event Wiring ---

    let isYoutubeSpaNavigating = false;
    let settledTwitchVodId = null;

    if (activeSite === 'twitch') {
        const initialTwitchState = readTwitchVodState();
        settledTwitchVodId = initialTwitchState ? initialTwitchState.mediaId : null;
    }

    function onTwitchMediaReady(event) {
        assert(event instanceof Event, 'onTwitchMediaReady requires an Event');

        const vodId = readTwitchVodIdFromUrl(window.location.href);
        if (!vodId) {
            settledTwitchVodId = null;
            return;
        }

        if (!(event.target instanceof HTMLVideoElement)) {
            return;
        }

        const playerElement = event.target.closest(TWITCH_PLAYER_SELECTOR);
        if (!(playerElement instanceof HTMLElement) || isTwitchPlayerShowingAd(playerElement)) {
            return;
        }

        settledTwitchVodId = vodId;
    }

    function onTwitchMediaEmptied(event) {
        assert(event instanceof Event, 'onTwitchMediaEmptied requires an Event');

        if (event.target instanceof HTMLVideoElement) {
            settledTwitchVodId = null;
        }
    }

    function syncTimestampToUrl(event) {
        assert(event instanceof Event, 'syncTimestampToUrl requires an Event');

        if (event.type === 'visibilitychange' && document.visibilityState !== 'hidden') {
            return;
        }

        let playerState = null;

        if (activeSite === 'youtube') {
            if (isYoutubeSpaNavigating) {
                return;
            }
            playerState = readYoutubeWatchState();
        } else if (activeSite === 'twitch') {
            playerState = readTwitchVodState();
            if (!playerState || playerState.mediaId !== settledTwitchVodId) {
                return;
            }
        } else {
            assert(false, 'Unhandled activeSite: ' + String(activeSite));
        }

        if (!playerState) {
            return;
        }

        const isMediaEvent = event.type === 'play' || event.type === 'pause' || event.type === 'seeked';
        if (isMediaEvent && event.target !== playerState.videoElement) {
            return;
        }

        const nextHref = buildTimestampedUrl(activeSite, window.location.href, playerState.timestampSeconds);
        commitUrlToHistory(nextHref);
    }

    if (activeSite === 'youtube') {
        document.addEventListener('yt-navigate-start', function () {
            isYoutubeSpaNavigating = true;
        });
        document.addEventListener('yt-navigate-finish', function () {
            isYoutubeSpaNavigating = false;
        });
        document.addEventListener('yt-navigate-error', function () {
            isYoutubeSpaNavigating = false;
        });
    }

    if (activeSite === 'twitch') {
        if ('navigation' in window && window.navigation && typeof window.navigation.addEventListener === 'function') {
            window.navigation.addEventListener('navigate', function (navigateEvent) {
                const destinationUrl = new URL(navigateEvent.destination.url);
                if (destinationUrl.pathname !== window.location.pathname) {
                    settledTwitchVodId = null;
                }
            });
        }

        document.addEventListener('loadedmetadata', onTwitchMediaReady, true);
        document.addEventListener('playing', onTwitchMediaReady, true);
        document.addEventListener('emptied', onTwitchMediaEmptied, true);
    }

    document.addEventListener('play', syncTimestampToUrl, true);
    document.addEventListener('pause', syncTimestampToUrl, true);
    document.addEventListener('seeked', syncTimestampToUrl, true);
    document.addEventListener('visibilitychange', syncTimestampToUrl);
    document.addEventListener('freeze', syncTimestampToUrl);
    window.addEventListener('pagehide', syncTimestampToUrl);
})();
