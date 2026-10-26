import { useCallback, useEffect, useRef, useState } from 'react';
import { vl } from './api/electron';
import { AnnotationEditor } from './components/annotations/AnnotationEditor';
import { AnnotationList } from './components/annotations/AnnotationList';
import { HotkeysDialog } from './components/dialogs/HotkeysDialog';
import { SettingsDialog } from './components/dialogs/SettingsDialog';
import { FileList } from './components/FileList';
import { TimingPanel } from './components/player/TimingPanel';
import { Timeline } from './components/player/Timeline';
import { VideoPlayer } from './components/player/VideoPlayer';
import { SearchResults } from './components/SearchResults';
import { Sidebar } from './components/sidebar/Sidebar';
import { Toolbar } from './components/Toolbar';
import { ToastHost } from './components/ui/Toast';
import { useSSE } from './hooks/useSSE';
import { t } from './lib/i18n';
import { useAnnotationsStore } from './state/annotationsStore';
import { useLibraryStore } from './state/libraryStore';
import { usePlayerStore } from './state/playerStore';
import { useTagsStore } from './state/tagsStore';
import { useUIStore } from './state/uiStore';
import './App.css';

const SSE_REFRESH_MS = 500;

export function App() {
  const selectedVideoId = useUIStore((state) => state.selectedVideoId);
  const centerView = useUIStore((state) => state.centerView);
  const setCenterView = useUIStore((state) => state.setCenterView);
  const sidebarWidth = useUIStore((state) => state.sidebarWidth);
  const previewHeight = useUIStore((state) => state.previewHeight);
  const setPreviewHeight = useUIStore((state) => state.setPreviewHeight);
  const backendReady = useUIStore((state) => state.backendReady);

  const videos = useLibraryStore((state) => state.videos);
  const loadVideos = useLibraryStore((state) => state.loadVideos);
  const scanPaths = useLibraryStore((state) => state.scanPaths);

  const [refreshToken, setRefreshToken] = useState(0);
  const refreshTimer = useRef<number | undefined>(undefined);

  const video = selectedVideoId
    ? (videos.find((item) => item.id === selectedVideoId) ?? null)
    : null;

  const bumpSidebar = useCallback(() => setRefreshToken((value) => value + 1), []);

  const scheduleLibraryRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = undefined;
      void useLibraryStore.getState().refresh();
      bumpSidebar();
    }, SSE_REFRESH_MS);
  }, [bumpSidebar]);

  const splitterDrag = useRef<{ startY: number; startHeight: number } | null>(null);

  const handleSplitterPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      splitterDrag.current = { startY: event.clientY, startHeight: previewHeight };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [previewHeight],
  );

  const handleSplitterPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = splitterDrag.current;
      if (!drag) return;
      setPreviewHeight(drag.startHeight - (event.clientY - drag.startY));
    },
    [setPreviewHeight],
  );

  const handleSplitterPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    splitterDrag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer capture уже снят */
    }
  }, []);

  const handleSplitterKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 60 : 20;
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPreviewHeight(previewHeight + step);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPreviewHeight(previewHeight - step);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setPreviewHeight(200);
      } else if (event.key === 'End') {
        event.preventDefault();
        setPreviewHeight(window.innerHeight - 260);
      }
    },
    [previewHeight, setPreviewHeight],
  );

  // Не даём панели «уехать» за пределы окна при ресайзе
  useEffect(() => {
    const onResize = (): void => setPreviewHeight(useUIStore.getState().previewHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setPreviewHeight]);

  const openVideo = useCallback((videoId: number, ms?: number) => {
    useUIStore.getState().selectVideo(videoId);
    if (ms !== undefined) {
      window.dispatchEvent(new CustomEvent('vl:seek', { detail: { videoId, ms } }));
    }
  }, []);

  // Первичная загрузка
  useEffect(() => {
    if (!backendReady) return;
    void loadVideos();
    void useTagsStore.getState().load();
  }, [backendReady, loadVideos]);

  // Сброс состояния при закрытии видео (загрузку делают VideoPlayer/TimingPanel)
  useEffect(() => {
    if (selectedVideoId == null) {
      usePlayerStore.getState().reset();
      useAnnotationsStore.getState().reset();
    }
  }, [selectedVideoId]);

  // События от других панелей (поиск, список меток)
  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ videoId: number; ms?: number }>).detail;
      if (!detail || typeof detail.videoId !== 'number') return;
      openVideo(detail.videoId, detail.ms);
    };
    window.addEventListener('vl:open', handleOpen as EventListener);
    return () => {
      window.removeEventListener('vl:open', handleOpen as EventListener);
    };
  }, [openVideo]);

  // SSE: прогресс, статусы, теги, метки
  useSSE((event) => {
    switch (event.type) {
      case 'video.status': {
        const payload = event.payload as { video_id?: number; status?: string } | null;
        scheduleLibraryRefresh();
        if (
          payload &&
          payload.status === 'done' &&
          payload.video_id != null &&
          payload.video_id === usePlayerStore.getState().videoId
        ) {
          void usePlayerStore.getState().reload();
        }
        break;
      }
      case 'video.progress':
      case 'folder.scanned':
        scheduleLibraryRefresh();
        break;
      case 'tags.changed':
        void useTagsStore.getState().refresh();
        bumpSidebar();
        break;
      case 'annotations.changed': {
        const videoId = usePlayerStore.getState().videoId;
        if (videoId !== null) {
          void useAnnotationsStore.getState().refresh(videoId);
        }
        void useLibraryStore.getState().refresh();
        break;
      }
      case 'settings.changed':
        break;
      default:
        break;
    }
  });

  // Глобальные горячие клавиши (остальные — в своих панелях)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editable =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (event.key === 'F1') {
        event.preventDefault();
        useUIStore.getState().setHotkeysOpen(true);
        return;
      }
      if (editable) return;
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyO') {
        event.preventDefault();
        void (async () => {
          const paths = await vl().openFiles();
          if (paths.length > 0) await scanPaths(paths);
        })();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyM') {
        event.preventDefault();
        if (usePlayerStore.getState().videoId !== null) {
          useAnnotationsStore.getState().createAtPlayhead();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [scanPaths]);

  const openAnnotation = useCallback(
    (videoId: number, startMs: number) => {
      setCenterView('files');
      openVideo(videoId, startMs);
    },
    [openVideo, setCenterView],
  );

  return (
    <div className="vl-app">
      <Toolbar />
      <div className="vl-app__body">
        <div className="vl-app__sidebar" style={{ width: sidebarWidth }}>
          <Sidebar refreshToken={refreshToken} />
        </div>
        <main className="vl-app__main">
          <SearchResults />
          <div className="vl-app__viewbar" role="tablist" aria-label={t('app.name')}>
            <button
              type="button"
              role="tab"
              aria-selected={centerView === 'files'}
              className={centerView === 'files' ? 'is-active' : ''}
              onClick={() => setCenterView('files')}
            >
              {t('sidebar.tabFiles')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={centerView === 'annotations'}
              className={centerView === 'annotations' ? 'is-active' : ''}
              onClick={() => setCenterView('annotations')}
            >
              {t('annotations.list')}
            </button>
          </div>
          <div className="vl-app__list">
            {centerView === 'files' ? (
              <FileList />
            ) : (
              <AnnotationList onOpen={openAnnotation} />
            )}
          </div>
          <div
            className="vl-app__splitter"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('preview.resize')}
            aria-valuenow={previewHeight}
            aria-valuemin={200}
            aria-valuemax={700}
            tabIndex={0}
            onPointerDown={handleSplitterPointerDown}
            onPointerMove={handleSplitterPointerMove}
            onPointerUp={handleSplitterPointerUp}
            onPointerCancel={handleSplitterPointerUp}
            onKeyDown={handleSplitterKeyDown}
            title={t('preview.resize')}
          />
          <section
            className="vl-app__preview"
            style={{ height: previewHeight }}
            aria-label={t('player.noVideo')}
          >
            <div className="vl-app__player">
              <VideoPlayer
                videoId={selectedVideoId}
                video={video}
                onShowInFolder={() => {
                  if (video) void vl().revealInExplorer(video.path);
                }}
              />
              {selectedVideoId !== null && (
                <Timeline videoId={selectedVideoId} durationMs={video?.duration_ms ?? undefined} />
              )}
            </div>
            <TimingPanel videoId={selectedVideoId} video={video} />
          </section>
        </main>
      </div>
      <AnnotationEditor />
      <SettingsDialog />
      <HotkeysDialog />
      <ToastHost />
    </div>
  );
}
