import { useToast } from '../lib/toast';

export default function Toast() {
    const text = useToast();
    if (!text) return null;
    return (
        <div className="toast-wrap" role="status" aria-live="polite">
            <div className="toast">{text}</div>
        </div>
    );
}
