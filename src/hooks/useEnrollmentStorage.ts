import { useState, useEffect, useCallback, useRef } from 'react';
import { calculateEffectiveDates } from '../utils/dateCalculations';

export interface Dependent {
  firstName: string;
  lastName: string;
  dob: string;
  smoker: string;
  relationship: 'Spouse' | 'Child';
  address?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  phone?: string;
  ssn?: string;
  gender?: string;
  email?: string;
  useSameAddress?: boolean;
}

export interface Product {
  id: string;
  name: string;
  image: string;
  selectedPlan: string;
  enrollmentFee: number;
  recurringFee: number;
  annualFee?: number;
  selectedProductId?: string;
  selectedIuaLevel?: string;
  extractedBenefitId?: string;
  extractedPrice?: number;
}

export interface PaymentInfo {
  paymentMethod: 'credit-card' | 'ach' | 'list-bill';
  ccType: string;
  ccNumber: string;
  ccExpMonth: string;
  ccExpYear: string;
  paymentType: string;
  achrouting: string;
  achaccount: string;
  achbank: string;
}

export interface QuestionnaireAnswers {
  referral: string;
  businessTaxId: string;
  zionPrinciplesAccept: string;
  zionm1a: string;
  zionm1b: string;
  zionm1d: string;
  /** Legacy; keep for API/PDF compatibility */
  zionm1h: string;
  zionTimelySubmission: string;
  zionmh1: string;
  zionmh2P: string;
  zionmh2: string;
  zionmh3: string;
  maternityDeliveryAck: string;
  primaryMemberConditionsPast36Mo: string;
  primaryMedicalTreatments: string;
  spouseMedicalConditions: string;
  medicalCostSharingAuth: boolean;
  termsAndConditionsAccept: boolean;
  signatureData: string;
  typedSignature: string;
}

export interface AppliedPromo {
  code: string;
  product: string;
  discountAmount: number;
}

export interface FormData {
  firstName: string;
  lastName: string;
  dob: string;
  email: string;
  smoker: string;
  address1: string;
  city: string;
  state: string;
  zipcode: string;
  phone: string;
  ssn: string;
  gender: string;
  agent: string;
  uniqueId: string;
  effectiveDate: string;
  benefitId: string | null;
  preExistingConditionsAcknowledged: string;
  dependents: Dependent[];
  products: Product[];
  payment: PaymentInfo;
  questionnaireAnswers: QuestionnaireAnswers;
  pdid: number;
  promoCode: string;
  appliedPromo: AppliedPromo | null;
}

const createDefaultFormData = (benefitId: string | null, agentId: string = ''): FormData => {
  const effectiveDates = calculateEffectiveDates();
  const defaultEffectiveDate = effectiveDates.length > 0 ? effectiveDates[0].value : '';

  return {
    firstName: '',
    lastName: '',
    dob: '',
    email: '',
    smoker: '',
    address1: '',
    city: '',
    state: '',
    zipcode: '',
    phone: '',
    ssn: '',
    gender: '',
    agent: agentId,
    uniqueId: '',
    effectiveDate: defaultEffectiveDate,
    benefitId,
    preExistingConditionsAcknowledged: '',
    dependents: [],
    products: [
      {
        id: 'secure-hsa',
        name: 'Premium HSA',
        image: '/assets/premiumhsa.png',
        selectedPlan: 'member-only',
        enrollmentFee: 0.00,
        recurringFee: 0,
        annualFee: 25.00,
        selectedProductId: '',
        selectedIuaLevel: '',
      },
    ],
    payment: {
      paymentMethod: 'credit-card',
      ccType: '',
      ccNumber: '',
      ccExpMonth: '',
      ccExpYear: '',
      paymentType: 'CC',
      achrouting: '',
      achaccount: '',
      achbank: '',
    },
    questionnaireAnswers: {
      referral: '',
      businessTaxId: '',
      zionPrinciplesAccept: '',
      zionm1a: '',
      zionm1b: '',
      zionm1d: '',
      zionm1h: '',
      zionTimelySubmission: '',
      zionmh1: '',
      zionmh2P: '',
      zionmh2: '',
      zionmh3: '',
      maternityDeliveryAck: '',
      primaryMemberConditionsPast36Mo: '',
      primaryMedicalTreatments: '',
      spouseMedicalConditions: '',
      medicalCostSharingAuth: false,
      termsAndConditionsAccept: false,
      signatureData: '',
      typedSignature: '',
    },
    pdid: 44036,
    promoCode: '',
    appliedPromo: null,
  };
};

export function useEnrollmentStorage(benefitId: string | null, agentId: string = '') {
  const [formData, setFormData] = useState<FormData>(() => createDefaultFormData(benefitId, agentId));
  const [currentStep, setCurrentStep] = useState<number>(1);
  const agentIdRef = useRef<string>(agentId);

  useEffect(() => {
    if (agentId && agentId !== agentIdRef.current) {
      agentIdRef.current = agentId;
      setFormData(prev => ({
        ...prev,
        agent: agentId
      }));
    }
  }, [agentId]);

  useEffect(() => {
    setFormData(prev => ({
      ...prev,
      benefitId
    }));
  }, [benefitId]);

  const saveFormData = useCallback((data: FormData) => {
    setFormData(data);
  }, []);

  const patchFormData = useCallback((partial: Partial<FormData>) => {
    setFormData((prev) => ({ ...prev, ...partial }));
  }, []);

  const saveStep = useCallback((step: number) => {
    setCurrentStep(step);
  }, []);

  const clearStorage = useCallback(() => {
    setFormData(createDefaultFormData(benefitId, agentIdRef.current));
    setCurrentStep(1);
  }, [benefitId]);

  const clearFormDataOnly = useCallback(() => {
    setFormData(createDefaultFormData(benefitId, agentIdRef.current));
  }, [benefitId]);

  return {
    formData,
    currentStep,
    saveFormData,
    patchFormData,
    saveStep,
    clearStorage,
    clearFormDataOnly,
  };
}
