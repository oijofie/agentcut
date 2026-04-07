"use client";

import { useEffect, useRef } from "react";
import { EditorCore } from "@/core";
import { getElementsAtTime, buildTextElement, buildImageElement } from "@/lib/timeline";
import { hasEffect, buildDefaultEffectInstance } from "@/lib/effects";
import { extractTimelineAudio } from "@/lib/media/mediabunny";
import { storageService } from "@/services/storage/service";
import type { VideoLabelsData } from "@/services/storage/types";
import type { VideoLabels } from "@/types/video-labels";
import type { TranscriptionLanguage } from "@/types/transcription";
import type {
	TimelineTrack,
	TimelineElement,
	CreateEffectElement,
} from "@/types/timeline";
import type { EffectParamValues } from "@/types/effects";

const WS_PORT = process.env.NEXT_PUBLIC_WS_PORT || "3001";
const WS_BRIDGE_URL = `ws://localhost:${WS_PORT}/ws?role=browser`;

interface WsCommand {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}

interface WsResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

function serializeTrack(track: TimelineTrack) {
  return {
    id: track.id,
    name: track.name,
    type: track.type,
    elements: track.elements.map((el: TimelineElement) => ({
      id: el.id,
      name: el.name,
      type: el.type,
      startTime: el.startTime,
      duration: el.duration,
      trimStart: el.trimStart,
      trimEnd: el.trimEnd,
      sourceDuration: el.sourceDuration,
    })),
  };
}

async function extractVideoFrames({
  url,
  interval,
}: {
  url: string;
  interval: number;
}): Promise<Array<{ time: number; image: string }>> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.muted = true;
    video.src = url;

    video.addEventListener("loadedmetadata", async () => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d")!;
      const duration = video.duration;
      const frames: Array<{ time: number; image: string }> = [];

      for (let t = 0; t < duration; t += interval) {
        video.currentTime = t;
        await new Promise<void>((res) => {
          video.addEventListener("seeked", () => res(), { once: true });
        });
        ctx.drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        const base64 = dataUrl.split(",")[1];
        frames.push({ time: t, image: base64 });
      }

      resolve(frames);
    });

    video.addEventListener("error", () => {
      reject(new Error("Failed to load video for frame extraction"));
    });
  });
}


async function handleCommand(cmd: WsCommand): Promise<WsResponse> {
  try {
    const editor = EditorCore.getInstance();
    const { type, params } = cmd;

    switch (type) {
      case "get_timeline": {
        const tracks = editor.timeline.getTracks();
        const totalDuration = editor.timeline.getTotalDuration();
        const currentTime = editor.playback.getCurrentTime();
        const isPlaying = editor.playback.getIsPlaying();
        return {
          id: cmd.id,
          ok: true,
          data: {
            tracks: tracks.map(serializeTrack),
            totalDuration,
            currentTime,
            isPlaying,
          },
        };
      }

      case "split": {
        const time = params?.time as number;
        if (time == null) return { id: cmd.id, ok: false, error: "time is required" };

        const tracks = editor.timeline.getTracks();
        const elements = getElementsAtTime({ tracks, time });
        if (elements.length === 0) {
          return { id: cmd.id, ok: false, error: `No elements found at time ${time}` };
        }

        editor.timeline.splitElements({
          elements,
          splitTime: time,
        });

        return { id: cmd.id, ok: true, data: { splitAt: time, elementsAffected: elements.length } };
      }

      case "remove_range": {
        const start = params?.start as number;
        const end = params?.end as number;
        if (start == null || end == null) {
          return { id: cmd.id, ok: false, error: "start and end are required" };
        }

        const tracks = editor.timeline.getTracks();

        // Split at start
        const elementsAtStart = getElementsAtTime({ tracks, time: start });
        if (elementsAtStart.length > 0) {
          editor.timeline.splitElements({ elements: elementsAtStart, splitTime: start });
        }

        // Split at end (re-read tracks after first split)
        const tracksAfterFirstSplit = editor.timeline.getTracks();
        const elementsAtEnd = getElementsAtTime({ tracks: tracksAfterFirstSplit, time: end });
        if (elementsAtEnd.length > 0) {
          editor.timeline.splitElements({ elements: elementsAtEnd, splitTime: end });
        }

        // Delete elements within the range
        const tracksAfterSplits = editor.timeline.getTracks();
        const elementsInRange: { trackId: string; elementId: string }[] = [];
        for (const track of tracksAfterSplits) {
          for (const el of track.elements) {
            const elStart = el.startTime;
            const elEnd = el.startTime + el.duration;
            // Element is fully within the range
            if (elStart >= start && elEnd <= end) {
              elementsInRange.push({ trackId: track.id, elementId: el.id });
            }
          }
        }

        if (elementsInRange.length > 0) {
          editor.timeline.deleteElements({
            elements: elementsInRange,
            rippleEnabled: true,
          });
        }

        return {
          id: cmd.id,
          ok: true,
          data: { removedRange: { start, end }, elementsDeleted: elementsInRange.length },
        };
      }

      case "trim": {
        const elementId = params?.elementId as string;
        if (!elementId) return { id: cmd.id, ok: false, error: "elementId is required" };

        editor.timeline.updateElementTrim({
          elementId,
          trimStart: params?.trimStart as number | undefined,
          trimEnd: params?.trimEnd as number | undefined,
          startTime: params?.startTime as number | undefined,
          duration: params?.duration as number | undefined,
          pushHistory: true,
        });

        return { id: cmd.id, ok: true, data: { elementId } };
      }

      case "undo": {
        if (!editor.command.canUndo()) {
          return { id: cmd.id, ok: false, error: "Nothing to undo" };
        }
        editor.command.undo();
        return { id: cmd.id, ok: true };
      }

      case "redo": {
        if (!editor.command.canRedo()) {
          return { id: cmd.id, ok: false, error: "Nothing to redo" };
        }
        editor.command.redo();
        return { id: cmd.id, ok: true };
      }

      case "seek": {
        const time = params?.time as number;
        if (time == null) return { id: cmd.id, ok: false, error: "time is required" };
        editor.playback.seek({ time });
        return { id: cmd.id, ok: true, data: { seekedTo: time } };
      }

      case "play": {
        if (!editor.playback.getIsPlaying()) {
          editor.playback.toggle();
        }
        return { id: cmd.id, ok: true };
      }

      case "pause": {
        if (editor.playback.getIsPlaying()) {
          editor.playback.toggle();
        }
        return { id: cmd.id, ok: true };
      }

      case "set_canvas_size": {
        const width = params?.width as number;
        const height = params?.height as number;
        if (!width || !height) return { id: cmd.id, ok: false, error: "width and height are required" };
        editor.project.updateSettings({
          settings: { canvasSize: { width, height } },
        });
        return { id: cmd.id, ok: true, data: { canvasSize: { width, height } } };
      }

      case "add_effect": {
        const effectType = params?.effectType as string;
        if (!effectType) return { id: cmd.id, ok: false, error: "effectType is required" };
        if (!hasEffect({ effectType })) {
          return { id: cmd.id, ok: false, error: `Unknown effect type: ${effectType}` };
        }

        const elementId = params?.elementId as string | undefined;
        const trackId = params?.trackId as string | undefined;
        const customParams = params?.params as EffectParamValues | undefined;

        if (elementId) {
          if (!trackId) return { id: cmd.id, ok: false, error: "trackId is required when elementId is provided" };
          const effectId = editor.timeline.addClipEffect({ trackId, elementId, effectType });
          return { id: cmd.id, ok: true, data: { effectId, appliedTo: "element", elementId } };
        }

        const totalDuration = editor.timeline.getTotalDuration();
        const defaultInstance = buildDefaultEffectInstance({ effectType });
        const effectParams = customParams
          ? { ...defaultInstance.params, ...customParams }
          : defaultInstance.params;

        const element: CreateEffectElement = {
          type: "effect",
          name: `${effectType} effect`,
          effectType,
          params: effectParams,
          startTime: 0,
          duration: totalDuration || 10,
          trimStart: 0,
          trimEnd: 0,
        };

        editor.timeline.insertElement({
          element,
          placement: { mode: "auto", trackType: "effect" },
        });

        return { id: cmd.id, ok: true, data: { appliedTo: "timeline", effectType } };
      }

      case "add_text": {
        const content = params?.content as string;
        if (!content) return { id: cmd.id, ok: false, error: "content is required" };

        const activeProject = editor.project.getActive();
        const canvasH = activeProject.settings.canvasSize.height;
        const totalDuration = editor.timeline.getTotalDuration();
        const positionPreset = params?.position as "center" | "top" | "bottom" | undefined;
        const letterboxAmount = 0.12;

        let posY = 0;
        if (positionPreset === "top") {
          posY = -(canvasH / 2) + (canvasH * letterboxAmount / 2);
        } else if (positionPreset === "bottom") {
          posY = (canvasH / 2) - (canvasH * letterboxAmount / 2);
        }

        const textElement = buildTextElement({
          raw: {
            content,
            fontSize: (params?.fontSize as number) ?? 2,
            color: (params?.color as string) ?? "#ffffff",
            transform: {
              scale: 1,
              position: {
                x: (params?.x as number) ?? 0,
                y: (params?.y as number) ?? posY,
              },
              rotate: 0,
            },
            duration: (params?.duration as number) ?? (totalDuration || 10),
            background: { enabled: false, color: "transparent" },
          },
          startTime: (params?.startTime as number) ?? 0,
        });

        editor.timeline.insertElement({
          element: textElement,
          placement: { mode: "auto", trackType: "text" },
        });

        return { id: cmd.id, ok: true, data: { content, position: positionPreset ?? "center" } };
      }

      case "add_image": {
        const mediaId = params?.mediaId as string;
        if (!mediaId) return { id: cmd.id, ok: false, error: "mediaId is required" };

        const mediaAssets = editor.media.getAssets();
        const asset = mediaAssets.find((a) => a.id === mediaId);
        if (!asset || asset.type !== "image") {
          return { id: cmd.id, ok: false, error: `Image asset not found: ${mediaId}` };
        }

        const totalDuration = editor.timeline.getTotalDuration();
        const startTime = (params?.startTime as number) ?? 0;
        const duration = (params?.duration as number) ?? (totalDuration || 10);

        const imageElement = buildImageElement({
          mediaId,
          name: asset.name,
          duration,
          startTime,
        });

        if (params?.x !== undefined || params?.y !== undefined || params?.scale !== undefined) {
          imageElement.transform = {
            ...imageElement.transform,
            scale: (params?.scale as number) ?? imageElement.transform.scale,
            position: {
              x: (params?.x as number) ?? 0,
              y: (params?.y as number) ?? 0,
            },
          };
        }

        if (params?.opacity !== undefined) {
          imageElement.opacity = params.opacity as number;
        }

        // Create a new track above the video track so image overlays on top
        const tracks = editor.timeline.getTracks();
        const videoTrackIndex = tracks.findIndex(
          (t) => t.type === "video" && t.elements.some((e) => e.type === "video"),
        );
        const insertIndex = videoTrackIndex >= 0 ? videoTrackIndex : 0;
        const newTrackId = editor.timeline.addTrack({ type: "video", index: insertIndex });

        editor.timeline.insertElement({
          element: imageElement,
          placement: { mode: "explicit", trackId: newTrackId },
        });

        return { id: cmd.id, ok: true, data: { mediaId, assetName: asset.name, startTime, duration } };
      }

      case "extract_video": {
        const totalDuration = editor.timeline.getTotalDuration();
        if (totalDuration === 0) {
          return { id: cmd.id, ok: false, error: "Timeline is empty" };
        }

        const result = await editor.renderer.exportProject({
          options: {
            format: "mp4",
            quality: "medium",
            includeAudio: false,
          },
        });

        if (!result.success || !result.buffer) {
          return {
            id: cmd.id,
            ok: false,
            error: result.error ?? "Export failed",
          };
        }

        const videoBytes = new Uint8Array(result.buffer);
        let videoBinary = "";
        for (let i = 0; i < videoBytes.length; i++) {
          videoBinary += String.fromCharCode(videoBytes[i]);
        }
        const videoBase64 = btoa(videoBinary);

        return {
          id: cmd.id,
          ok: true,
          data: {
            video: videoBase64,
            duration: totalDuration,
          },
        };
      }

      case "extract_audio": {
        const tracks = editor.timeline.getTracks();
        const mediaAssets = editor.media.getAssets();
        const totalDuration = editor.timeline.getTotalDuration();

        if (totalDuration === 0) {
          return { id: cmd.id, ok: false, error: "Timeline is empty" };
        }

        const audioBlob = await extractTimelineAudio({
          tracks,
          mediaAssets,
          totalDuration,
        });

        const arrayBuffer = await audioBlob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        return {
          id: cmd.id,
          ok: true,
          data: { audio: base64, duration: totalDuration },
        };
      }

      case "list_media": {
        const assets = editor.media.getAssets();
        const serialized = assets.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          width: a.width,
          height: a.height,
          duration: a.duration,
        }));
        return { id: cmd.id, ok: true, data: { assets: serialized } };
      }

      case "get_video_frames": {
        const mediaId = params?.mediaId as string;
        const interval = (params?.interval as number) ?? 5;
        if (!mediaId) return { id: cmd.id, ok: false, error: "mediaId is required" };

        const assets = editor.media.getAssets();
        const asset = assets.find((a) => a.id === mediaId);
        if (!asset || !asset.url) {
          return { id: cmd.id, ok: false, error: `Media not found: ${mediaId}` };
        }

        const frames = await extractVideoFrames({ url: asset.url, interval });
        return { id: cmd.id, ok: true, data: { frames, mediaId, interval } };
      }

      case "transcribe_local": {
        const language = (params?.language as TranscriptionLanguage) ?? "auto";

        const audioBlob = await extractTimelineAudio({
          tracks: editor.timeline.getTracks(),
          mediaAssets: editor.media.getAssets(),
          totalDuration: editor.timeline.getTotalDuration(),
        });

        const formData = new FormData();
        formData.append("file", audioBlob, "audio.wav");
        if (language !== "auto") {
          formData.append("language", language);
        }

        const response = await fetch("/api/transcribe", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          return {
            id: cmd.id,
            ok: false,
            error:
              (errorData as { error?: string }).error ??
              `Transcription failed (${response.status})`,
          };
        }

        const result = (await response.json()) as {
          text: string;
          segments: { text: string; start: number; end: number }[];
          language: string;
        };

        return {
          id: cmd.id,
          ok: true,
          data: {
            text: result.text,
            segments: result.segments,
            language: result.language,
          },
        };
      }

      case "save_video_labels": {
        const labels = params?.labels as VideoLabels;
        if (!labels?.mediaId) {
          return { id: cmd.id, ok: false, error: "labels with mediaId required" };
        }
        const projectId = editor.project.getActive().metadata.id;
        await storageService.saveVideoLabels({ projectId, labels });
        return { id: cmd.id, ok: true, data: { mediaId: labels.mediaId } };
      }

      case "get_video_labels": {
        const mediaId = params?.mediaId as string;
        if (!mediaId) {
          return { id: cmd.id, ok: false, error: "mediaId is required" };
        }
        const projectId = editor.project.getActive().metadata.id;
        const labels = await storageService.loadVideoLabels({ projectId, mediaId });
        return { id: cmd.id, ok: true, data: labels };
      }

      default:
        return { id: cmd.id, ok: false, error: `Unknown command: ${type}` };
    }
  } catch (e) {
    return { id: cmd.id, ok: false, error: String(e) };
  }
}

export function useWsBridge() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(WS_BRIDGE_URL);

      ws.onopen = () => {
        console.log("[ws-bridge] connected to bridge server");
      };

      ws.onmessage = async (event) => {
        try {
          const cmd = JSON.parse(event.data as string) as WsCommand;
          const response = await handleCommand(cmd);
          ws.send(JSON.stringify(response));
        } catch (e) {
          console.error("[ws-bridge] failed to handle message:", e);
        }
      };

      ws.onclose = () => {
        console.log("[ws-bridge] disconnected, reconnecting in 3s...");
        reconnectTimerRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };

      wsRef.current = ws;
    }

    connect();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []);
}
