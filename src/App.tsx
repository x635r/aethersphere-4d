/**
 * App — composition root.
 *
 * Wires the data pipeline (`useWeatherField`) to the map and the HUD, syncs the
 * store's timeline, and installs the keyboard shortcuts. Every HUD panel is
 * individually guarded so a panel fault degrades one card, not the app.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AetherMap } from './components/AetherMap';
import { LayerMatrixDock } from './components/LayerMatrixDock';
import { AltitudeElevator } from './components/AltitudeElevator';
import { ChronosBar } from './components/ChronosBar';
import { ColorbarLegend } from './components/ColorbarLegend';
import { ProbePanel } from './components/ProbePanel';
import { RenderControls } from './components/RenderControls';
import { StatusHeader } from './components/StatusHeader';
import { PanelBoundary } from './components/PanelBoundary';
import { AnalysisToolbar } from './components/AnalysisToolbar';
import { SkewTSoundingModal } from './components/SkewTSoundingModal';
import { AtmosphericCrossSection } from './components/AtmosphericCrossSection';
import { MultiModelArena } from './components/MultiModelArena';
import { AtmosphericRivers } from './components/AtmosphericRivers';
import { RadarAndChem } from './components/RadarAndChem';
import { SpaghettiContours } from './components/SpaghettiContours';
import { AviationWeatherCenter } from './components/AviationWeatherCenter';
import { SpaceWeatherAurora } from './components/SpaceWeatherAurora';
import { CycloneChronicle } from './components/CycloneChronicle';
import { ClimateTimeMachine } from './components/ClimateTimeMachine';
import { useWeatherField } from './hooks/useWeatherField';
import { useAnalysisTools, type ToolMode } from './hooks/useAnalysisTools';
import { useStage3 } from './hooks/useStage3';
import { useStage4, type MapBounds } from './hooks/useStage4';
import { useStage5 } from './hooks/useStage5';
import { useAppStore } from './state/store';
import { DAY_NIGHT_ACCENT } from './constants';

export default function App() {
  const level = useAppStore((s) => s.level);
  const scalarId = useAppStore((s) => s.scalarId);
  const times = useAppStore((s) => s.times);
  const timeIndex = useAppStore((s) => s.timeIndex);
  const setTimes = useAppStore((s) => s.setTimes);
  const setStatus = useAppStore((s) => s.setStatus);
  const setFieldSet = useAppStore((s) => s.setFieldSet);
  const setError = useAppStore((s) => s.setError);
  const setSynthetic = useAppStore((s) => s.setSynthetic);
  const togglePlaying = useAppStore((s) => s.togglePlaying);
  const setProjection = useAppStore((s) => s.setProjection);
  const projection = useAppStore((s) => s.projection);

  const { fieldSet, loading, error, meta, synthetic } = useWeatherField({ level, scalarId });

  /* ---------------- Stage 2 instrument state ---------------- */
  const [toolMode, setToolMode] = useState<ToolMode>('probe');

  // The analysis tools operate on an absolute instant, so the timeline cursor
  // and the panels always agree.
  const currentTimeMs = useMemo(() => {
    if (times.length === 0) return Date.now();
    const idx = Math.max(0, Math.min(times.length - 1, timeIndex));
    return times[idx] ?? Date.now();
  }, [times, timeIndex]);

  const tools = useAnalysisTools({ mode: toolMode, timeMs: currentTimeMs });

  const handleModeChange = useCallback((next: ToolMode) => {
    setToolMode(next);
    if (next !== 'section') tools.cancelSection();
    if (next !== 'sounding') tools.closeSounding();
  }, [tools]);

  /* ---------------- Stage 3 instruments ---------------- */
  const probeForStage3 = useAppStore((s) => s.probe);
  const stage3Point = useMemo(
    () =>
      probeForStage3
        ? { lat: probeForStage3.lat, lng: probeForStage3.lng }
        : null,
    [probeForStage3],
  );

  const stage3 = useStage3({ timeMs: currentTimeMs, probePoint: stage3Point });

  /* ---------------- Stage 4 instruments ---------------- */
  const [bounds, setBounds] = useState<MapBounds | null>(null);
  const handleBoundsChange = useCallback((next: MapBounds) => setBounds(next), []);

  const stage4 = useStage4({ bounds });

  // Clicking an airport on the map opens the aviation panel; the panel owns the
  // crosswind instrument, so no selection state is lifted here.
  const handleAirportClick = useCallback(() => {
    stage4.openPanel('aviation');
  }, [stage4]);

  /* ---------------- Stage 5 instruments ---------------- */
  const stage5 = useStage5({ probe: stage3Point });

  /* ---------------- propagate pipeline state into the store ---------------- */
  useEffect(() => {
    setStatus(loading ? 'loading' : error ? 'error' : fieldSet ? 'ready' : 'idle');
  }, [loading, error, fieldSet, setStatus]);

  useEffect(() => {
    setError(error);
  }, [error, setError]);

  useEffect(() => {
    setSynthetic(synthetic);
  }, [synthetic, setSynthetic]);

  useEffect(() => {
    if (!fieldSet) return;
    setFieldSet(fieldSet, meta);
    setTimes(fieldSet.times);
  }, [fieldSet, meta, setFieldSet, setTimes]);

  /* ---------------- keyboard shortcuts ---------------- */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal keys from form controls.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      switch (event.key.toLowerCase()) {
        case ' ':
          event.preventDefault();
          togglePlaying();
          break;
        case 'g':
          setProjection(projection === 'globe' ? 'mercator' : 'globe');
          break;
        case 's':
          event.preventDefault();
          handleModeChange(toolMode === 'sounding' ? 'probe' : 'sounding');
          break;
        case 'x':
          event.preventDefault();
          handleModeChange(toolMode === 'section' ? 'probe' : 'section');
          break;
        case 'k':
          event.preventDefault();
          stage5.openPanel('museum');
          break;
        case 't':
          event.preventDefault();
          stage5.openPanel('climate');
          break;
        case 'a':
          event.preventDefault();
          stage4.openPanel('space');
          break;
        case 'c':
          event.preventDefault();
          stage4.openPanel('aviation');
          break;
        case 'm':
          event.preventDefault();
          // Prefer the probed point; otherwise fall back to the timeline's
          // current map centre is unavailable here, so use the last probe or
          // prompt by opening the panel in its "pick a point" state.
          if (stage3Point) stage3.requestArena(stage3Point);
          else stage3.openPanel('arena');
          break;
        case 'r':
          event.preventDefault();
          stage3.openPanel('rivers');
          break;
        case 'z':
          event.preventDefault();
          stage3.openPanel('radar');
          break;
        case 'p':
          event.preventDefault();
          stage3.openPanel('spaghetti');
          break;
        case 'escape':
          // Escape returns to the neutral probe mode and clears any draft, and
          // closes whichever Stage 3 panel is open.
          handleModeChange('probe');
          tools.cancelSection();
          stage3.closePanel('arena');
          stage3.closePanel('rivers');
          stage3.closePanel('radar');
          stage3.closePanel('spaghetti');
          stage4.closePanel('aviation');
          stage4.closePanel('space');
          stage5.closePanel('museum');
          stage5.closePanel('climate');
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [togglePlaying, setProjection, projection, toolMode, handleModeChange, tools, stage3, stage4, stage5]);

  /* ---------------- derived UI values ---------------- */
  const statusText = useMemo(() => {
    if (error) return error;
    if (loading) return '同步中';
    if (fieldSet) return '在线';
    return '待命';
  }, [error, loading, fieldSet]);

  const accent = DAY_NIGHT_ACCENT;

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#030712]">
      {/* map canvas */}
      <div className="absolute inset-0">
        <AetherMap
          fieldSet={fieldSet}
          timeIndex={timeIndex}
          toolMode={toolMode}
          sectionNodes={tools.draftNodes}
          sectionDrafting={toolMode === 'section' && !tools.sectionOpen}
          sectionHighlight={tools.sectionHighlight}
          onSoundingRequest={tools.requestSounding}
          onSectionNode={tools.addSectionNode}
          radarMetadata={stage3.radar}
          radarFrameIndex={stage3.radarFrameIndex}
          radarVisible={stage3.radarVisible && stage3.panels.radar}
          chemField={stage3.chemField}
          chemVisible={stage3.chemVisible}
          chemOpacity={stage3.chemOpacity}
          ivtField={stage3.ivt}
          ivtVisible={stage3.ivtVisible}
          ivtOpacity={stage3.ivtOpacity}
          awaitingArenaPoint={stage3.panels.arena && !stage3.arenaPoint}
          onArenaPoint={stage3.requestArena}
          hazards={stage4.hazards}
          hazardsVisible={stage4.hazardsVisible}
          airports={stage4.airports}
          airportsVisible={stage4.airportsVisible}
          flights={stage4.flights}
          flightsVisible={stage4.flightsVisible}
          aurora={stage4.aurora}
          auroraVisible={stage4.auroraVisible}
          auroraOpacity={stage4.auroraOpacity}
          onBoundsChange={handleBoundsChange}
          onAirportClick={handleAirportClick}
          cycloneTrack={stage5.activeTrack}
          cycloneActiveIndex={stage5.timeIndex}
          cycloneVisible={stage5.visible}
          cycloneShowRings={stage5.showRings}
        />
      </div>

      {/* HUD */}
      <div className="pointer-events-none absolute inset-0 z-20">
        <PanelBoundary label="状态栏">
          <StatusHeader />
        </PanelBoundary>

        <PanelBoundary label="分析工具栏">
          <AnalysisToolbar
            mode={toolMode}
            onChange={handleModeChange}
            draftCount={tools.draftNodes.length}
            onFinishSection={tools.finishSection}
            onCancelSection={tools.cancelSection}
            disabled={!fieldSet}
          />
        </PanelBoundary>

        <PanelBoundary label="图层矩阵">
          <LayerMatrixDock
            onOpenArena={() => stage3.openPanel('arena')}
            onOpenRivers={() => stage3.openPanel('rivers')}
            onOpenRadar={() => stage3.openPanel('radar')}
            onOpenSpaghetti={() => stage3.openPanel('spaghetti')}
            onOpenAviation={() => stage4.openPanel('aviation')}
            onOpenSpace={() => stage4.openPanel('space')}
            onOpenCyclone={() => stage5.openPanel('museum')}
            onOpenClimate={() => stage5.openPanel('climate')}
            cycloneVisible={stage5.visible}
            onToggleCyclone={stage5.toggleVisible}
            hazardsVisible={stage4.hazardsVisible}
            onToggleHazards={stage4.toggleHazards}
            airportsVisible={stage4.airportsVisible}
            onToggleAirports={stage4.toggleAirports}
            flightsVisible={stage4.flightsVisible}
            onToggleFlights={stage4.toggleFlights}
            auroraVisible={stage4.auroraVisible}
            onToggleAurora={stage4.toggleAurora}
            radarAvailable={!stage3.radarError}
            ivtAvailable={!stage3.ivtError}
            ivtVisible={stage3.ivtVisible}
            onToggleIvt={stage3.toggleIvt}
            chemVisible={stage3.chemVisible}
            onToggleChem={stage3.toggleChemVisible}
          />
        </PanelBoundary>

        <PanelBoundary label="高度层">
          <AltitudeElevator />
        </PanelBoundary>

        {toolMode === 'probe' ? (
          <PanelBoundary label="十字探针">
            <ProbePanel />
          </PanelBoundary>
        ) : null}

        <PanelBoundary label="色标图例">
          <ColorbarLegend />
        </PanelBoundary>

        {/* Render controls sit directly above the timeline, right of the legend,
            so the two left-hand cards never compete for the same corner. */}
        <PanelBoundary label="渲染调参">
          <RenderControls />
        </PanelBoundary>

        <PanelBoundary label="时间轴">
          <ChronosBar />
        </PanelBoundary>

        {/* hidden live region for status text, keeps a11y honest */}
        <p className="sr-only" aria-live="polite">
          AetherSphere 状态：{statusText}。当前等压面 {level}，变量 {scalarId}，
          {times.length} 个时次。
        </p>
      </div>

      {/* ---- Stage 2 instruments ---- */}
      <PanelBoundary label="探空斜温图">
        <SkewTSoundingModal
          open={tools.soundingOpen}
          onClose={tools.closeSounding}
          profile={tools.sounding}
          loading={tools.soundingLoading}
          error={tools.soundingError}
          onRetry={tools.retrySounding}
          timeMs={currentTimeMs}
        />
      </PanelBoundary>

      <PanelBoundary label="垂直剖面舱">
        <AtmosphericCrossSection
          open={tools.sectionOpen}
          onClose={tools.closeSection}
          data={tools.section}
          loading={tools.sectionLoading}
          error={tools.sectionError}
          onRetry={tools.retrySection}
          onHoverPoint={tools.setSectionHighlight}
          timeMs={currentTimeMs}
        />
      </PanelBoundary>

      {/* ---- Stage 3 instruments ---- */}
      <PanelBoundary label="多模型竞技场">
        <MultiModelArena
          open={stage3.panels.arena}
          onClose={() => stage3.closePanel('arena')}
          arena={stage3.arena}
          loading={stage3.arenaLoading}
          error={stage3.arenaError}
          onRetry={stage3.retryArena}
          variable={stage3.arenaVariable}
          onVariableChange={stage3.setArenaVariable}
          point={stage3.arenaPoint}
          timeIndex={stage3.arenaTimeIndex}
          onTimeIndexChange={stage3.setArenaTimeIndex}
        />
      </PanelBoundary>

      <PanelBoundary label="天河追踪">
        <AtmosphericRivers
          open={stage3.panels.rivers}
          onClose={() => stage3.closePanel('rivers')}
          field={stage3.ivt}
          loading={stage3.ivtLoading}
          error={stage3.ivtError}
          onRetry={stage3.retryIvt}
          visible={stage3.ivtVisible}
          onToggleVisible={stage3.toggleIvt}
          opacity={stage3.ivtOpacity}
          onOpacityChange={stage3.setIvtOpacity}
          probeIvt={stage3.probeIvt}
          timeMs={currentTimeMs}
        />
      </PanelBoundary>

      <PanelBoundary label="雷达与化学">
        <RadarAndChem
          open={stage3.panels.radar}
          onClose={() => stage3.closePanel('radar')}
          radar={stage3.radar}
          radarLoading={stage3.radarLoading}
          radarError={stage3.radarError}
          radarFrameIndex={stage3.radarFrameIndex}
          onRadarFrameChange={stage3.setRadarFrameIndex}
          radarPlaying={stage3.radarPlaying}
          onToggleRadarPlay={stage3.toggleRadarPlaying}
          radarVisible={stage3.radarVisible}
          onToggleRadarVisible={stage3.toggleRadarVisible}
          onRetryRadar={stage3.retryRadar}
          chemVariable={stage3.chemVariable}
          onChemVariableChange={stage3.setChemVariable}
          chemField={stage3.chemField}
          chemLoading={stage3.chemLoading}
          chemError={stage3.chemError}
          chemVisible={stage3.chemVisible}
          onToggleChemVisible={stage3.toggleChemVisible}
          chemOpacity={stage3.chemOpacity}
          onChemOpacityChange={stage3.setChemOpacity}
          onRetryChem={stage3.retryChem}
          chemPoint={stage3.chemPoint}
          pointLabel={stage3Point ? `${stage3Point.lat.toFixed(2)}°, ${stage3Point.lng.toFixed(2)}°` : null}
        />
      </PanelBoundary>

      <PanelBoundary label="面条图">
        <SpaghettiContours
          open={stage3.panels.spaghetti}
          onClose={() => stage3.closePanel('spaghetti')}
          result={stage3.spaghetti}
          loading={stage3.spaghettiLoading}
          error={stage3.spaghettiError}
          onRetry={stage3.retrySpaghetti}
          timeMs={currentTimeMs}
          contourLevel={5880}
        />
      </PanelBoundary>

      {/* ---- Stage 4 instruments ---- */}
      <PanelBoundary label="航空气象">
        <AviationWeatherCenter
          open={stage4.panels.aviation}
          onClose={() => stage4.closePanel('aviation')}
          hazards={stage4.hazards}
          hazardsLoading={stage4.hazardsLoading}
          hazardsError={stage4.hazardsError}
          hazardsVisible={stage4.hazardsVisible}
          onToggleHazards={stage4.toggleHazards}
          onRetryHazards={stage4.retryHazards}
          airports={stage4.airports}
          airportsLoading={stage4.airportsLoading}
          airportsError={stage4.airportsError}
          airportsVisible={stage4.airportsVisible}
          onToggleAirports={stage4.toggleAirports}
          onRetryAirports={stage4.retryAirports}
          pireps={stage4.pireps}
          flights={stage4.flights}
          flightsVisible={stage4.flightsVisible}
          onToggleFlights={stage4.toggleFlights}
          onRetryFlights={stage4.refreshFlights}
          flightsLoading={stage4.flightsLoading}
          flightsError={stage4.flightsError}
        />
      </PanelBoundary>

      <PanelBoundary label="空间天气">
        <SpaceWeatherAurora
          open={stage4.panels.space}
          onClose={() => stage4.closePanel('space')}
          aurora={stage4.aurora}
          auroraLoading={stage4.auroraLoading}
          auroraError={stage4.auroraError}
          auroraVisible={stage4.auroraVisible}
          onToggleAurora={stage4.toggleAurora}
          onRetryAurora={stage4.retryAurora}
          auroraOpacity={stage4.auroraOpacity}
          onAuroraOpacityChange={stage4.setAuroraOpacity}
          kp={stage4.kp}
          kpLoading={stage4.kpLoading}
          kpError={stage4.kpError}
          onRetryKp={stage4.retryKp}
          probe={stage3Point}
        />
      </PanelBoundary>

      {/* ---- Stage 5 instruments ---- */}
      <PanelBoundary label="台风博物馆">
        <CycloneChronicle
          open={stage5.panels.museum}
          onClose={() => stage5.closePanel('museum')}
          records={stage5.records}
          selectedId={stage5.selectedId}
          onSelect={stage5.selectCyclone}
          timeIndex={stage5.timeIndex}
          onTimeIndexChange={stage5.setTimeIndex}
          visible={stage5.visible}
          onToggleVisible={stage5.toggleVisible}
          showRings={stage5.showRings}
          onToggleRings={stage5.toggleRings}
          compareIds={stage5.compareIds}
          onToggleCompare={stage5.toggleCompare}
          comparisonMetric={stage5.comparisonMetric}
          onComparisonMetric={stage5.setComparisonMetric}
          arenaPoint={stage5.arenaPoint}
          onSetArenaPoint={stage5.setArenaPoint}
          probePoint={stage3Point}
          onImportFile={stage5.importFile}
          importWarnings={stage5.importWarnings}
          importError={stage5.importError}
        />
      </PanelBoundary>

      <PanelBoundary label="气候时间机">
        <ClimateTimeMachine
          open={stage5.panels.climate}
          onClose={() => stage5.closePanel('climate')}
          point={stage5.climatePoint}
          daily={stage5.daily}
          dailyLoading={stage5.dailyLoading}
          dailyError={stage5.dailyError}
          selectedDate={stage5.selectedDate}
          onDateChange={stage5.setSelectedDate}
          onRetryDaily={stage5.retryDaily}
          onJumpToEvent={stage5.jumpToEvent}
          series={stage5.series}
          stripes={stage5.stripes}
          seriesLoading={stage5.seriesLoading}
          seriesError={stage5.seriesError}
          onRetrySeries={stage5.retrySeries}
          span={stage5.climateSpan}
        />
      </PanelBoundary>

      {/* accent hairline along the top edge */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-30 h-px"
        style={{
          background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
          opacity: 0.5,
        }}
      />
    </div>
  );
}
