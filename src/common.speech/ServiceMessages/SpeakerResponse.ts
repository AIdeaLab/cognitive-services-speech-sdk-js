// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

export interface ISpeakerResponse {
    scenario: string;
    status: SpeakerStatus;
    verificationResult?: VerificationResult;
    identificationResult?: IdentificationResult;
}

export interface SpeakerStatus {
    statusCode: string;
    reason: string;
}

export interface VerificationResult {
    result: string;
    score: number;
}

export interface IdentificationResult {
    identifiedProfile: ProfileScore;
    profilesRanking: ProfileScore[];
}

export interface ProfileScore {
    profileId: string;
    score: number;
}

export class SpeakerResponse implements ISpeakerResponse  {
    private privSpeakerResponse: ISpeakerResponse;

    private constructor(json: string) {
        this.privSpeakerResponse = JSON.parse(json) as ISpeakerResponse;
    }

    public static fromJSON(json: string): SpeakerResponse {
        return new SpeakerResponse(json);
    }

    public get scenario(): string {
        return this.privSpeakerResponse.scenario;
    }

    public get status(): SpeakerStatus {
        return this.privSpeakerResponse.status;
    }
}