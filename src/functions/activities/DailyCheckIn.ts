import { AxiosRequestConfig } from "axios";
import { randomBytes } from "crypto";

import { URLS } from "../../constants";
import { DashboardData } from "../../interface/DashboardData";
import { getErrorMessage } from "../../util/core/Utils";
import { Workers } from "../Workers";

export class DailyCheckIn extends Workers {
  public async doDailyCheckIn(accessToken: string, data: DashboardData) {
    this.bot.log(
      this.bot.isMobile,
      "DAILY-CHECK-IN",
      "Starting Daily Check In",
    );

    try {
      const geoLocale = this.resolveGeoLocale(data);

      const jsonData = {
        amount: 1,
        country: geoLocale,
        id: randomBytes(64).toString("hex"),
        type: 101,
        attributes: {
          offerid: "Gamification_Sapphire_DailyCheckIn",
        },
      };

      const claimRequest: AxiosRequestConfig = {
        url: URLS.REWARDS_API_ACTIVITIES,
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "X-Rewards-Country": geoLocale,
          "X-Rewards-Language": "en",
        },
        data: JSON.stringify(jsonData),
      };

      const claimResponse = await this.bot.axios.request(claimRequest);
      const claimedPoint =
        parseInt((await claimResponse.data).response?.activity?.p, 10) || 0;

      this.bot.log(
        this.bot.isMobile,
        "DAILY-CHECK-IN",
        claimedPoint > 0
          ? `Claimed ${claimedPoint} points`
          : "Already claimed today",
      );
    } catch (error) {
      this.bot.log(
        this.bot.isMobile,
        "DAILY-CHECK-IN",
        `An error occurred: ${getErrorMessage(error)}`,
        "error",
      );
    }
  }
}
