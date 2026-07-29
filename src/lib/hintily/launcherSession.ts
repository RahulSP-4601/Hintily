import type { HintilyLauncherSurface } from '../../components/hintily/LauncherSessionSetup';

export interface HintilyAudioSelection {
  inputDeviceId: string;
  outputDeviceId: string;
}

export interface HintilyCalendarEventSelection {
  id: string;
  title: string;
  startTime: string;
  endTime?: string;
  attendees?: Array<{ email?: string; displayName?: string }>;
}

export interface HintilyLauncherStartRequest {
  surface: HintilyLauncherSurface;
  modeId: string;
  modeTemplateType: string;
  title: string;
  company?: string;
  role?: string;
  context?: string;
  participants?: string;
  calendarEvent?: HintilyCalendarEventSelection;
  audio: HintilyAudioSelection;
}

export interface HintilyLauncherSetupHandle {
  start: () => Promise<void>;
  focus: () => void;
}

export interface HintilyMode {
  id: string;
  name: string;
  templateType: string;
  customContext: string;
  isActive: boolean;
  createdAt: string;
  referenceFileCount: number;
}

export const isInterviewTemplate = (templateType: string): boolean => {
  const normalized = templateType.trim().toLowerCase();
  return normalized === 'technical-interview'
    || normalized === 'looking-for-work'
    || normalized.includes('interview');
};

export const modeMatchesSurface = (
  mode: Pick<HintilyMode, 'templateType'>,
  surface: HintilyLauncherSurface,
): boolean => surface === 'interview_helper'
  ? isInterviewTemplate(mode.templateType)
  : !isInterviewTemplate(mode.templateType);

