import { useHashRoute } from './lib/useHashRoute';
import { ToastProvider } from './components/ui';
import { Library } from './components/Library';
import { ProjectView } from './components/ProjectView';
import { MaskEditor } from './components/MaskEditor';
import { CaptureView } from './components/CaptureView';
import { Guide } from './components/Guide';

export default function App() {
  const route = useHashRoute();
  const [head, id, section, sectionId] = route.parts;

  let screen = <Library />;
  if (head === 'guide') {
    screen = <Guide />;
  } else if (head === 'p' && id) {
    if (section === 'capture') screen = <CaptureView projectId={id} />;
    else if (section === 'photo' && sectionId) screen = <MaskEditor projectId={id} photoId={sectionId} />;
    else screen = <ProjectView projectId={id} />;
  }

  return <ToastProvider>{screen}</ToastProvider>;
}
