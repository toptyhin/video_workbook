import { useCallback, useEffect, useRef, useState } from 'react';
import { vl } from './api/electron';
import type { EmbeddingProgressPayload, EmbeddingStatePayload } from './api/types';
import { AnnotationEditor } from './components/annotations/AnnotationEditor';
import { AnnotationList } from './components/annotations/AnnotationList';
import { LaunchDialog } from './components/external/LaunchDialog';
import { HotkeysDialog } from './components/dialogs/HotkeysDialog';
import { SettingsDialog } from './components/dialogs/SettingsDialog';
import { FileList } from './components/FileList';
import { FolderPickerDialog } from './components/FolderPickerDialog';
import { TimingPanel } from './components/player/TimingPanel';
import { Timeline } from './components/player/Timeline';
import { VideoPlayer } from './components/player/VideoPlayer';
import { SearchResults } from './components/SearchResults';
import { Sidebar } from './components/sidebar/Sidebar';
import { Toolbar } from './components/Toolbar';
import { RecordDialog } from './components/recording/RecordDialog';
import { RecorderBar } from './components/recording/RecorderBar';
import { RecordingPreview } from './components/recording/RecordingPreview';
import { ToastHost } from './components/ui/Toast';
import { useSSE } from './hooks/useSSE';
import { t } from './lib/i18n';
import { useAnnotationsStore } from './state/annotationsStore';
import { useExternalStore } from './state/externalStore';
import { useFileBrowserStore } from './state/fileBrowserStore';
import { useLibraryStore } from './state/libraryStore';
import { useModelsStore } from './state/modelsStore';
import { usePlayerStore } from './state/playerStore';
import { useRecordStore } from './state/recordStore';
import { useSearchStore, selectSearchActive } from './state/searchStore';
import { useSummaryStore } from './state/summaryStore';
import { useTagsStore } from './state/tagsStore';
import { useUIStore, type CenterView } from './state/uiStore';
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
  // Активный поиск заменяет список файлов/меток панелью результатов (plans/12 §4.2).
  const searchActive = useSearchStore(selectSearchActive);
  const clearSearch = useSearchStore((state) => state.clear);
  const recordStatus = useRecordStore((state) => state.status);
  const recordingActive =
    recordStatus === 'preparing' ||
    recordStatus === 'recording' ||
    recordStatus === 'paused' ||
    recordStatus === 'finalizing';

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
    void useExternalStore.getState().init();
    // Статус семантического индекса нужен для переключателя режимов поиска.
    void useSearchStore.getState().loadSemanticStatus();
    // История адресатов и watched roots для «Переместить/Скопировать в папку» (plans/15 §4.4).
    void useFileBrowserStore.getState().initialize();
  }, [backendReady, loadVideos]);

  // Позиция/состояние внешнего плеера -> playerStore (таймлайн, тайминги, метки)
  useEffect(
    () =>
      useExternalStore.subscribe((state) => {
        const session = state.status.active ? state.status.session : null;
        const player = usePlayerStore.getState();
        if (!session) {
          if (player.playing) player.setPlaying(false);
          return;
        }
        if (player.videoId !== session.video_id) return;
        player.setPosition(session.position_ms);
        if (session.duration_ms > 0) player.setDuration(session.duration_ms);
        player.setPlaying(!session.paused);
      }),
    [],
  );

  // Старт записи ставит встроенный плеер на паузу: он больше не виден в панели,
  // а его звук иначе попал бы в запись (системный звук/микрофон).
  useEffect(() => {
    if (recordStatus !== 'recording') return;
    const player = usePlayerStore.getState();
    if (player.playing) player.pause();
  }, [recordStatus]);

  // Переключение видео закрывает внешний плеер другого файла
  useEffect(() => {
    const external = useExternalStore.getState();
    const session = external.status.active ? external.status.session : null;
    if (!session) return;
    if (selectedVideoId === null || session.video_id !== selectedVideoId) {
      void external.stop();
    }
  }, [selectedVideoId]);

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
      case 'external.state':
        void useExternalStore.getState().refreshStatus();
        break;
      case 'embedding.progress': {
        const payload = event.payload as EmbeddingProgressPayload | null;
        if (payload && typeof payload.indexed === 'number' && typeof payload.total === 'number') {
          useSearchStore.getState().applySemanticProgress(payload);
        }
        break;
      }
      case 'embedding.state': {
        const payload = event.payload as EmbeddingStatePayload | null;
        useSearchStore.getState().applySemanticState(payload?.state === 'indexing');
        break;
      }
      case 'model.progress':
      case 'model.state':
        useModelsStore.getState().applyEvent({ type: event.type, payload: event.payload });
        useSummaryStore.getState().applyEvent({ type: event.type, payload: event.payload });
        break;
      case 'summary.progress':
      case 'summary.state':
        useSummaryStore.getState().applyEvent({ type: event.type, payload: event.payload });
        break;
      case 'settings.changed': {
        const payload = event.payload as { keys?: string[] } | null;
        const keys = payload?.keys ?? [];
        if (keys.length === 0 || keys.some((key) => key.startsWith('summary.'))) {
          void useSummaryStore.getState().loadSettings(true);
        }
        if (keys.length === 0 || keys.some((key) => key.startsWith('models.'))) {
          void useModelsStore.getState().load();
        }
        break;
      }
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
      if ((event.ctrlKey || event.metaKey) && event.code === 'Enter') {
        event.preventDefault();
        const videoId = useUIStore.getState().selectedVideoId;
        if (videoId !== null) {
          useExternalStore.getState().openLaunch(videoId, usePlayerStore.getState().positionMs);
        }
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

  // Вкладка «Файлы/Метки» при активном поиске закрывает результаты и возвращает список.
  const handleCenterView = useCallback(
    (view: CenterView) => {
      setCenterView(view);
      clearSearch();
    },
    [clearSearch, setCenterView],
  );

  return (
    <div className="vl-app">
      <Toolbar />
      <div className="vl-app__body">
        <div className="vl-app__sidebar" style={{ width: sidebarWidth }}>
          <Sidebar refreshToken={refreshToken} />
        </div>
        <main className="vl-app__main">
          <div className="vl-app__viewbar" role="tablist" aria-label={t('app.name')}>
            <button
              type="button"
              role="tab"
              aria-selected={centerView === 'files'}
              className={centerView === 'files' ? 'is-active' : ''}
              onClick={() => handleCenterView('files')}
            >
              {t('sidebar.tabFiles')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={centerView === 'annotations'}
              className={centerView === 'annotations' ? 'is-active' : ''}
              onClick={() => handleCenterView('annotations')}
            >
              {t('annotations.list')}
            </button>
          </div>
          {/* Результаты живут ПОД полосой вкладок и заменяют список файлов/меток,
              получая всё оставшееся место (исправление перекрытия, plans/12 §4.2). */}
          {searchActive ? (
            <SearchResults />
          ) : (
            <div className="vl-app__list">
              {centerView === 'files' ? (
                <FileList />
              ) : (
                <AnnotationList onOpen={openAnnotation} />
              )}
            </div>
          )}
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
            aria-label={recordingActive ? t('recording.previewLabel') : t('player.noVideo')}
          >
            <div className="vl-app__player">
              {recordingActive ? (
                <RecordingPreview />
              ) : (
                <>
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
                </>
              )}
            </div>
            <TimingPanel videoId={selectedVideoId} video={video} />
          </section>
        </main>
      </div>
      <AnnotationEditor />
      <LaunchDialog />
      <FolderPickerDialog />
      <RecordDialog />
      <RecorderBar />
      <SettingsDialog />
      <HotkeysDialog />
      <ToastHost />
    </div>
  );
}
