// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import { ReplayableAudioNode } from "../common.browser/Exports";
import {
    Deferred,
    IAudioSource,
    IAudioStreamNode,
    IConnection,
    MessageType,
} from "../common/Exports";
import { AudioStreamFormatImpl } from "../sdk/Audio/AudioStreamFormat";
import { SpeakerRecognitionModel } from "../sdk/SpeakerRecognitionModel";
import {
    CancellationErrorCode,
    CancellationReason,
    SpeakerRecognitionResult,
    VoiceProfileClient,
    PropertyCollection,
    PropertyId,
    ResultReason,
    SessionEventArgs,
    SpeakerRecognitionResultType,
    VoiceProfileType
} from "../sdk/Exports";
import {
    CancellationErrorCodePropertyName,
    IProfile,
    ISpeechConfigAudioDevice,
    ProfileResponse,
    ServiceRecognizerBase,
} from "./Exports";
import { IAuthentication } from "./IAuthentication";
import { IConnectionFactory } from "./IConnectionFactory";
import { RecognizerConfig } from "./RecognizerConfig";
import { SpeechConnectionMessage } from "./SpeechConnectionMessage.Internal";

interface CreateProfile {
    scenario: string;
    locale: string;
}

interface SpeakerContext {
    scenario: string;
    profileIds: string[];
    features: {
        interimResult: string;
        progressiveDetection: string;
    };
}

// eslint-disable-next-line max-classes-per-file
export class VoiceServiceRecognizer extends ServiceRecognizerBase {
    private privVoiceProfileClient: VoiceProfileClient;
    private privSpeakerAudioSource: IAudioSource;
    private privResultDeferral: Deferred<SpeakerRecognitionResult>;
    private privSpeakerModel: SpeakerRecognitionModel;
    private  privCreateProfileDeferralMap: { [id: string]: Deferred<string[]> };

    public constructor(
        authentication: IAuthentication,
        connectionFactory: IConnectionFactory,
        audioSource: IAudioSource,
        recognizerConfig: RecognizerConfig,
        recognizer: VoiceProfileClient) {
        super(authentication, connectionFactory, audioSource, recognizerConfig, recognizer);
        this.privVoiceProfileClient = recognizer;
        this.privSpeakerAudioSource = audioSource;
        this.recognizeSpeaker = (model: SpeakerRecognitionModel): Promise<SpeakerRecognitionResult> => this.recognizeSpeakerOnce(model);
        this.sendPrePayloadJSONOverride = (): Promise<void> => this.noOp();
    }

    protected processTypeSpecificMessages(connectionMessage: SpeechConnectionMessage): Promise<boolean> {

        let result: SpeakerRecognitionResult;
        let processed: boolean = false;

        const resultProps: PropertyCollection = new PropertyCollection();
        if (connectionMessage.messageType === MessageType.Text) {
            resultProps.setProperty(PropertyId.SpeechServiceResponse_JsonResult, connectionMessage.textBody);
        }

        switch (connectionMessage.path.toLowerCase()) {
            // Profile management response for create, fetch, delete, reset
            case "speaker.profiles":
                const response: ProfileResponse = ProfileResponse.fromJSON(connectionMessage.textBody);
                switch (response.operation.toLowerCase()) {
                    case "create":
                        this.handleCreateResponse(response, connectionMessage.requestId);
                        break;

                    default:
                        break;
                }
                processed = true;
                break;
            default:
                break;
        }
        const defferal = new Deferred<boolean>();
        defferal.resolve(processed);
        return defferal.promise;
    }

    // Cancels recognition.
    protected cancelRecognition(
        sessionId: string,
        requestId: string,
        cancellationReason: CancellationReason,
        errorCode: CancellationErrorCode,
        error: string): void {

        const properties: PropertyCollection = new PropertyCollection();
        properties.setProperty(CancellationErrorCodePropertyName, CancellationErrorCode[errorCode]);

        /*
        if (!!this.privSpeakerRecognizer.canceled) {

            const cancelEvent: RecognitionCanceledEventArgs = new SpeakerRecognitionCanceledEventArgs(
                cancellationReason,
                error,
                errorCode,
                undefined,
                undefined,
                sessionId);
            try {
                this.privSpeakerRecognizer.canceled(this.privIntentRecognizer, cancelEvent);
            } catch { }
        }

        if (!!this.privResultDeferral) {
            const result: SpeakerRecognitionResult = new SpeakerRecognitionResult(
                SpeakerRecognitionResultType.Identify,
                error,
                "",
                ResultReason.Canceled,
                );
            try {
                this.privResultDeferral.resolve(result);
                this.privResultDeferral = undefined;
            } catch (error) {
                this.privResultDeferral.reject(error as string);
            }
        }
        */

        if (!!this.privResultDeferral) {
            const resultType = this.privSpeakerModel.scenario === "TextIndependentIdentification" ? SpeakerRecognitionResultType.Identify : SpeakerRecognitionResultType.Verify;
            const result: SpeakerRecognitionResult = new SpeakerRecognitionResult(
                resultType,
                error,
                this.privSpeakerModel.profileIds[0],
                ResultReason.Canceled,
                errorCode,
                );
            try {
                this.privResultDeferral.resolve(result);
            } catch (error) {
                this.privResultDeferral.reject(error as string);
            }
        }
    }

    public async createProfile(profileType: VoiceProfileType, locale: string): Promise<string[]> {
        const createProfileDeferral = new Deferred<string[]>();

        // Start the connection to the service. The promise this will create is stored and will be used by configureConnection().
        const conPromise: Promise<IConnection> = this.connectImpl();
        try {
            const connection: IConnection = await conPromise;
            this.privRequestSession.onSpeechContext();
            this.privCreateProfileDeferralMap[this.privRequestSession.requestId] = createProfileDeferral;
            await this.sendCreateProfile(connection, profileType, locale);
        } catch (err) {
            throw err;
        }
        void this.receiveMessage();
        return createProfileDeferral.promise;
    }

    public async recognizeSpeakerOnce(model: SpeakerRecognitionModel): Promise<SpeakerRecognitionResult> {
        this.privSpeakerModel = model;
        if (!this.privResultDeferral) {
            this.privResultDeferral = new Deferred<SpeakerRecognitionResult>();
        }
        this.privRequestSession.startNewRecognition();
        this.privRequestSession.listenForServiceTelemetry(this.privSpeakerAudioSource.events);

        this.privRecognizerConfig.parameters.setProperty(PropertyId.Speech_SessionId, this.privRequestSession.sessionId);

        // Start the connection to the service. The promise this will create is stored and will be used by configureConnection().
        const conPromise: Promise<IConnection> = this.connectImpl();

        const preAudioPromise: Promise<void> = this.sendPreAudioMessages(this.extractSpeakerContext(model));

        const node: IAudioStreamNode = await this.privSpeakerAudioSource.attach(this.privRequestSession.audioNodeId);
        const format: AudioStreamFormatImpl = await this.privSpeakerAudioSource.format;
        const deviceInfo: ISpeechConfigAudioDevice = await this.privSpeakerAudioSource.deviceInfo;

        const audioNode = new ReplayableAudioNode(node, format.avgBytesPerSec);
        await this.privRequestSession.onAudioSourceAttachCompleted(audioNode, false);

        this.privRecognizerConfig.SpeechServiceConfig.Context.audio = { source: deviceInfo };

        try {
            await conPromise;
            await preAudioPromise;
        } catch (err) {
            this.cancelRecognition(this.privRequestSession.sessionId, this.privRequestSession.requestId, CancellationReason.Error, CancellationErrorCode.ConnectionFailure, err as string);
        }

        const sessionStartEventArgs: SessionEventArgs = new SessionEventArgs(this.privRequestSession.sessionId);

        if (!!this.privClient.sessionStarted) {
            this.privClient.sessionStarted(this.privClient, sessionStartEventArgs);
        }

        void this.receiveMessage();
        const audioSendPromise = this.sendAudio(audioNode);

        // /* eslint-disable no-empty */
        audioSendPromise.then((): void => { /* add? return true;*/ }, (error: string): void => {
            this.cancelRecognition(this.privRequestSession.sessionId, this.privRequestSession.requestId, CancellationReason.Error, CancellationErrorCode.RuntimeError, error);
        });

        return this.privResultDeferral.promise;
    }

    private async sendPreAudioMessages(context: SpeakerContext): Promise<void> {
        const connection: IConnection = await this.fetchConnection();
        await this.sendSpeakerRecognition(connection, context);
        // await this.sendWaveHeader(connection);
    }

    private async sendSpeakerRecognition(connection: IConnection, context: SpeakerContext): Promise<void> {
        const speakerContextJson = JSON.stringify(context);
        return connection.send(new SpeechConnectionMessage(
            MessageType.Text,
            "speaker.context",
            this.privRequestSession.requestId,
            "application/json; charset=utf-8",
            speakerContextJson));
    }

    private async sendCreateProfile(connection: IConnection, profileType: VoiceProfileType, locale: string): Promise<void> {

        const scenario = profileType === VoiceProfileType.TextIndependentIdentification ? "TextIndependentIdentification" :
            profileType === VoiceProfileType.TextIndependentVerification ? "TextIndependentVerification" : "TextDependentVerification";

        const profileCreateRequest: CreateProfile = {
            locale,
            scenario,
        };
        return connection.send(new SpeechConnectionMessage(
            MessageType.Text,
            "speaker.profile.create",
            this.privRequestSession.requestId,
            "application/json; charset=utf-8",
            JSON.stringify(profileCreateRequest)));
    }

    private extractSpeakerContext(model: SpeakerRecognitionModel): SpeakerContext {
        return {
            features: {
                interimResult: "enabled",
                progressiveDetection: "disabled",
            },
            profileIds: model.profileIds,
            scenario: model.scenario,
        };
    }

    private handleCreateResponse(response: ProfileResponse, requestId: string): void {
        if (response.status.statusCode.toLowerCase() !== "success") {
            throw new Error(`Voice Profile create failed, message: ${response.status.reason}`);
        }
        if (!response.profiles || response.profiles.length < 1) {
            throw new Error("Voice Profile create failed, no profiles received");
        }
        if (!!this.privCreateProfileDeferralMap[requestId]) {
            this.privCreateProfileDeferralMap[requestId].resolve(response.profiles.map( (profile: IProfile): string => profile.profileId ));
        } else {
            throw new Error(`Voice Profile create request for requestID ${requestId} not found`);
        }
    }

}