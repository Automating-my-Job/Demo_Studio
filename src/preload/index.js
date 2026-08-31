'use strict';
/**
 * preload — the renderer's whole world. Nothing else crosses the bridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('demoStudio', {
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  diagnose: invoke('settings:diagnose'),
  pickFolder: invoke('dialog:pickFolder'),
  scanProject: invoke('project:scan'),
  loadProject: invoke('project:load'),
  saveProject: invoke('project:save'),
  scaffoldProject: invoke('project:scaffold'),
  createUrlProject: invoke('project:createUrl'),
  listVoices: invoke('voices:list'),
  startJob: invoke('job:start'),
  cancelJob: invoke('job:cancel'),
  reveal: invoke('shell:reveal'),
  openExternal: invoke('shell:openExternal'),
  /** file path → studio-media:// URL the <video>/<audio> tags can load. */
  mediaUrl: (filePath) => 'studio-media://local' + encodeURI(filePath),
  onJobEvent: (cb) => {
    const listener = (e, msg) => cb(msg);
    ipcRenderer.on('job:event', listener);
    return () => ipcRenderer.removeListener('job:event', listener);
  },
});
