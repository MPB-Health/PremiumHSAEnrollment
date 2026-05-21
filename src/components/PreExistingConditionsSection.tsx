import { AlertCircle } from 'lucide-react';
import {
  PRE_EXISTING_CONDITIONS_INTRO,
  PRE_EXISTING_CONDITIONS_SCHEDULE_LINES,
  PRE_EXISTING_CONDITIONS_TITLE,
} from '../constants/preExistingConditionsCopy';

interface PreExistingConditionsSectionProps {
  value: string;
  error?: string;
  onChange: (value: string) => void;
}

export default function PreExistingConditionsSection({
  value,
  error,
  onChange,
}: PreExistingConditionsSectionProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 mb-4">
        <AlertCircle className="w-5 h-5 text-blue-600" />
        <h2 className="text-xl font-semibold text-gray-800">{PRE_EXISTING_CONDITIONS_TITLE}</h2>
      </div>

      <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-6">
        <div className="prose prose-sm max-w-none">
          <p className="text-gray-800 leading-relaxed mb-4">{PRE_EXISTING_CONDITIONS_INTRO}</p>

          <ul className="space-y-2 text-gray-700 list-none pl-0">
            {PRE_EXISTING_CONDITIONS_SCHEDULE_LINES.map(({ emphasis, rest }) => (
              <li key={emphasis} className="flex items-start gap-2">
                <span className="font-semibold text-blue-700 mt-0.5">•</span>
                <span>
                  <strong className="text-gray-900">{emphasis}</strong>
                  {rest}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-6 pt-6 border-t-2 border-blue-200">
          <label className="block text-sm font-medium text-gray-700 mb-3">
            Do you acknowledge and agree to these terms? <span className="text-red-500">*</span>
          </label>

          <div className="flex gap-6">
            <label className="flex items-center gap-3 cursor-pointer group">
              <input
                type="radio"
                name="preExistingConditions"
                value="Yes"
                checked={value === 'Yes'}
                onChange={(e) => onChange(e.target.value)}
                className="w-5 h-5 text-blue-600 border-gray-300 focus:ring-2 focus:ring-blue-500 cursor-pointer"
                aria-required="true"
              />
              <span className="text-base font-medium text-gray-800 group-hover:text-blue-700 transition">
                Yes
              </span>
            </label>

            <label className="flex items-center gap-3 cursor-pointer group">
              <input
                type="radio"
                name="preExistingConditions"
                value="No"
                checked={value === 'No'}
                onChange={(e) => onChange(e.target.value)}
                className="w-5 h-5 text-blue-600 border-gray-300 focus:ring-2 focus:ring-blue-500 cursor-pointer"
                aria-required="true"
              />
              <span className="text-base font-medium text-gray-800 group-hover:text-blue-700 transition">
                No
              </span>
            </label>
          </div>

          {error && (
            <p className="mt-2 text-sm text-red-500 font-medium" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
