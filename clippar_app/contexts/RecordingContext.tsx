import React, { createContext, useContext, useState } from 'react';

type RecordingContextType = {
  isRecordingActive: boolean;
  setRecordingActive: (v: boolean) => void;
};

const RecordingContext = createContext<RecordingContextType>({
  isRecordingActive: false,
  setRecordingActive: () => {},
});

export function RecordingProvider({ children }: { children: React.ReactNode }) {
  const [isRecordingActive, setRecordingActive] = useState(false);
  return (
    <RecordingContext.Provider value={{ isRecordingActive, setRecordingActive }}>
      {children}
    </RecordingContext.Provider>
  );
}

export function useRecordingContext() {
  return useContext(RecordingContext);
}
