#include <stdio.h>
#include <string.h>

#define MAX_SLOTS 20


struct Vehicle {
    char number[15];
    char type[10];   
    int hours;
    float charge;
    int slot;
    int isParked;
};

struct Vehicle parking[MAX_SLOTS];

float calculateCharge(char type[], int hours) {
    float rate;
    if (strcmp(type, "car") == 0) {
        rate = 20; // per hour
    } else if (strcmp(type, "bike") == 0) {
        rate = 10;
    } else if (strcmp(type, "truck") == 0) {
        rate = 30;
    } else {
        rate = 15;
    }
    return rate * hours;
}

void showAvailableSlots() {
    printf("\n Available Slots \n");
    for (int i = 0; i < MAX_SLOTS; i++) {
        if (parking[i].isParked == 0) {
            printf("Slot %d is empty\n", i + 1);
        }
    }
}

void parkVehicle() {
    int slotFound = -1;
    for (int i = 0; i < MAX_SLOTS; i++) {
        if (parking[i].isParked == 0) {
            slotFound = i;
            break;
        }
    }

    if (slotFound == -1) {
        printf(" Parking is Full, No slot available.\n");
        return;
    }

    struct Vehicle v;
    printf("\nEnter Vehicle Number: ");
    scanf("%s", v.number);
    printf("Enter Vehicle Type (car/bike/truck): ");
    scanf("%s", v.type);
    printf("Enter No. of Hours: ");
    scanf("%d", &v.hours);

    v.charge = calculateCharge(v.type, v.hours);
    v.slot = slotFound + 1;
    v.isParked = 1;

    parking[slotFound] = v;

    printf(" Vehicle parked at slot %d. Charge = %.2f\n", v.slot, v.charge);
}

void removeVehicle() {
    char num[15];
    int found = 0;
    printf("\nEnter Vehicle Number to remove: ");
    scanf("%s", num);

    for (int i = 0; i < MAX_SLOTS; i++) {
        if (parking[i].isParked == 1 && strcmp(parking[i].number, num) == 0) {
            printf("Vehicle %s removed from slot %d.\n", parking[i].number, parking[i].slot);
            printf("Total Charge: %.2f\n", parking[i].charge);
            parking[i].isParked = 0;
            found = 1;
            break;
        }
    }

    if (!found) {
        printf(" Vehicle not found.\n");
    }
}

void displayParked() {
    printf("\nParked Vehicles:n");
    for (int i = 0; i < MAX_SLOTS; i++) {
        if (parking[i].isParked == 1) {
            printf("Slot %d | Number: %s | Type: %s | Hours: %d | Charge: %.2f\n",
                   parking[i].slot, parking[i].number, parking[i].type,
                   parking[i].hours, parking[i].charge);
        }
}
}

int main() {
    int choice;
    for (int i = 0; i < MAX_SLOTS; i++) {
        parking[i].isParked = 0;
    }

    do {
        printf("\nParking Lot\n");
        printf("1. Show Available Slots\n");
        printf("2. Park a Vehicle\n");
        printf("3. Remove a Vehicle\n");
        printf("4. Display All Parked Vehicles\n");
        printf("5. Exit\n");
        printf("Enter Choice: ");
        scanf("%d", &choice);

        switch (choice) {
            case 1:
                showAvailableSlots();
                break;
            case 2:
                parkVehicle();
                break;
            case 3:
                removeVehicle();
                break;
            case 4:
                displayParked();
                break;
            case 5:
                printf("Exiting... 👋\n");
                break;
            default:
                printf("Invalid choice!\n");
        }
    } while (choice != 5);

    return 0;
}